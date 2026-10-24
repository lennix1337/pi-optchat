import { EventEmitter } from 'node:events';
import { FileStore, storeFor, type Saved, type Store, type TerminalRecord } from './store.ts';

export const NODE = 512;
export const VIEW = 128_000;
/** While the prompt cache is warm the chat view puts off its batch merge until it reaches this many times its budget, since
 * the batch rewrites the view from near its top and the next request misses the cache. */
export const DEFER = 1.5;
/** A turn starting this long after the last request finds the provider's 5-minute cache expired, so merging then costs nothing. */
export const COLD_MS = 270_000;
export const CAP = 30_000;
/** The most characters one zoom into a message returns, so a page stays under the tool output CAP instead of losing its middle. */
export const PAGE = 25_000;
export const KINDS = ['user', 'talk', 'tool', 'echo', 'note', 'work'] as const;
export type Kind = typeof KINDS[number];
export interface Origin { source: 'claude' | 'claude-memory' | 'codex' | 'pi' | 'chatgpt'; conversation: string; message: string; title: string; project?: string }
export interface Entry { i: number; kind: Kind; text: string; size: number; date: string; receipt?: string; origin?: Origin }
export interface Part { l: number; i: number }
export interface Summary extends Part { text: string; size: number }
/** `part` is the node to build: a message's leaf, or the merge of its two halves. A tool result can carry the call it answers;
 * a call can carry its output once available, so its summary preserves what it found. */
export interface Compression { context: string; source: string; part: Part; historical?: boolean; result?: string; call?: { i: number; text: string } }
export type Compressor = (input: Compression, signal: AbortSignal) => Promise<string>;
const key = ({ l, i }: Part) => l * 2 ** 40 + i;
const POLICY_REFUSAL = 'OPTCHAT_POLICY_REFUSAL' as const;
const UNBUILT = '(not summarized yet: zoom it)';
export const start = ({ l, i }: Part) => i * 2 ** l;
export const end = (part: Part) => start(part) + 2 ** part.l;
export const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const UNBUILT_BYTES = bytes(UNBUILT);
/** The most of a tool result a call's summary task shows. */
const RESULT = 12_000;
/** Bound repeated-search caching to eight queries and 20,000 message indexes; broad and long queries are not retained. */
const SEARCH_CACHE_QUERIES = 8;
const SEARCH_CACHE_HITS = 20_000;
const SEARCH_CACHE_QUERY_CHARS = 256;
const KIND_HEAD = new RegExp(`^\\s*(?:${KINDS.join('|')})\\s*:\\s*`, 'i');
/** A cheap model can head a summary with the kind of a <chat> line it copied, so the code sets the message's own. */
export const labeled = (kind: Kind, text: string) => `${kind}: ${text.replace(KIND_HEAD, '')}`;
export const flat = (s: string) => s.replace(/[\r\n]+/g, ' ');
const messageScope = (count: number) => count === 0 ? 'Memory has no messages yet.' : `Messages run 0-${count - 1}`;
/** The error for a zoom range that does not exist, naming the ranges that do. */
export const noLine = (id: number, n: number, count: number) => new Error(`No line ${id}+${n}. ${count === 0 ? messageScope(count)
  : `${messageScope(count)}; n is a power of two, id a multiple of n, id+n at most ${count}.`}`);
const lineBytes = (s: string) => bytes(flat(s));
const notice = (omitted: number) => `\n[${omitted} characters omitted; head and tail retained. Zoom can recover the full output only when the original is durable.]\n`;
const VIEW_OPEN = '<chat>\n';
const VIEW_FRAME_BYTES = bytes(`${VIEW_OPEN}</chat>`);
export const isView = (text: string) => text.startsWith(VIEW_OPEN);
export function cap(text: string, limit = CAP) {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - notice(text.length).length) / 2);
  const head = text.slice(0, /[\ud800-\udbff]/.test(text[half - 1]) ? half - 1 : half);
  const tail = text.slice(/[\udc00-\udfff]/.test(text[text.length - half]) ? text.length - half + 1 : text.length - half);
  return head + notice(text.length - head.length - tail.length) + tail;
}

/** The index of the view's most due pair of sibling lines whose parent is built, or -1 (recipe §3.2). A pair is as due as
 * long ago it ended, in its own line size; equal pairs go oldest first. This is the order of Taelin's rollback push. */
export function mostDue(view: readonly Part[], total: number, built: (part: Part) => boolean) {
  let best = -1, due = -Infinity;
  for (let j = 0; j + 1 < view.length; j++) {
    const a = view[j], b = view[j + 1];
    if (a.l !== b.l || a.i % 2 || b.i !== a.i + 1) continue;
    const age = (total - (end(b) - 1)) / 2 ** a.l;
    if (age > due && built({ l: a.l + 1, i: a.i / 2 })) { best = j; due = age; }
  }
  return best;
}
/** A view (recipe §3.2): lines that tile the log, oldest first. It grows a line per message and, once over `ceiling` bytes, over
 * `high` when the cache is cold, or when forced, merges its most due pairs in one batch down to `low`, merging what it can at each
 * change until then. */
class Sawtooth {
  readonly parts: Part[] = [];
  private measured = 0;
  merging = false;
  constructor(private readonly high: number, private readonly low: number, private readonly node: (part: Part) => Summary | undefined,
    private readonly ceiling = high) {}
  private lineSize(part: Part) { return bytes(`${start(part)}+${2 ** part.l}|\n`) + (this.node(part)?.size ?? UNBUILT_BYTES); }
  get size() { return VIEW_FRAME_BYTES + this.measured + (this.parts.length ? 0 : 1); } // render() keeps a blank line in an empty view.
  push(part: Part) { this.parts.push(part); this.measured += this.lineSize(part); }
  /** The line covering message `at`. The lines tile the log in order, so a binary search finds it. */
  covering(at: number): Part | undefined {
    for (let lo = 0, hi = this.parts.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1, p = this.parts[mid];
      if (end(p) <= at) lo = mid + 1;
      else if (start(p) > at) hi = mid - 1;
      else return p;
    }
  }
  /** A message got its node. Its line is usually still shown, but after a damaged tree file a saved parent can already hide it. */
  built(i: number) { if (this.covering(i)?.l === 0) this.measured += this.node({ l: 0, i })!.size - UNBUILT_BYTES; }
  /** Returns whether any lines merged. */
  fit(total: number, force = false, cold = false) {
    const lines = this.parts.length;
    if (force || this.size > (cold ? this.high : this.ceiling)) this.merging = true;
    for (let best: number; this.merging && this.size > this.low && (best = mostDue(this.parts, total, part => !!this.node(part))) >= 0;) {
      const a = this.parts[best], b = this.parts[best + 1], parent = { l: a.l + 1, i: a.i / 2 };
      this.measured += this.lineSize(parent) - this.lineSize(a) - this.lineSize(b);
      this.parts.splice(best, 2, parent);
    }
    if (this.size <= this.low) this.merging = false;
    return this.parts.length < lines;
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function isEntry(value: unknown): value is Entry {
  return object(value) && Number.isSafeInteger(value.i) && typeof value.kind === 'string'
    && KINDS.some(kind => kind === value.kind)
    && typeof value.text === 'string' && typeof value.date === 'string';
}
function isSummary(value: unknown): value is Summary {
  return object(value) && Number.isSafeInteger(value.l) && Number.isSafeInteger(value.i)
    && typeof value.text === 'string';
}
function isTerminalRecord(value: unknown): value is TerminalRecord {
  return object(value) && !('text' in value) && (value.type === 'terminal' || value.type === 'retry')
    && Number.isSafeInteger(value.l) && Number.isSafeInteger(value.i) && value.code === POLICY_REFUSAL;
}
function isPolicyRefusal(error: unknown) {
  return object(error) && error.code === POLICY_REFUSAL;
}

/** The log is authoritative. The tree and the view follow the recipe: the view grows a line per message and, once it passes
 * `budget`, merges its most due pairs in one batch down to half of it, so between batches it only grows at its end. With `defer`
 * above 1 it waits for a cold turn (`cool`) or `defer` times the budget, so warm turns keep the cached prefix.
 * Compactions get their own view (recipe §4): the chat's merged further, to between an eighth and a quarter of the budget,
 * and again whenever the chat's merges, so parallel compactions read it from the cache. */
export class Memory {
  readonly root: Entry[] = [];
  readonly tree = new Map<number, Summary>();
  private readonly events = new EventEmitter();
  private readonly controller = new AbortController();
  private readonly busy = new Map<number, Promise<void>>();
  private readonly retryAt = new Map<number, number>();
  private readonly terminal = new Map<number, typeof POLICY_REFUSAL>();
  private readonly reported = new Set<number>();
  /** Messages without their node, and merges whose halves are built, oldest first, so the scheduler never scans the tree for work (recipe §4). */
  private readonly unbuilt = new Set<number>();
  private readonly merges = new Map<number, Part>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** The most summaries owed at once since none were last owed. */
  private peak = 0;
  private scheduled = false;
  private stopped = false;
  /** Waiters that need every line now, so a call's summary stops waiting for its result. */
  private flushing = 0;
  private readonly chat: Sawtooth;
  private readonly compaction: Sawtooth;
  /** Complete newest-first hit indexes keyed by lowercased query; `before` pages filter this bounded result. */
  private readonly searchCache = new Map<string, number[]>();
  private searchCacheHits = 0;
  /** The last store write still running, if any. Once an append fails, later writes are skipped and appends throw, as after a failed file write. */
  private writing?: Promise<void>;
  private failed?: string;
  /** Where this memory's local files live: all of it for a FileStore, and the browser page, runs and imports for any store. */
  readonly directory: string;
  readonly store: Store;
  lastError?: string;

  /** Opens the memory in `directory` through the store `storeFor` picks, after its load. */
  static async open(directory: string, compress: Compressor, warn: (s: string) => void = console.error, budget = VIEW, jobs = 8, retryMs?: number, defer = 1) {
    const store = storeFor(directory, warn);
    return new Memory({ directory, store, saved: await store.load() }, compress, warn, budget, jobs, retryMs, defer);
  }
  /** A directory alone opens a FileStore there. `jobs`: summaries built at once, and how many unbuilt lines a new message's node
   * waits behind. Chat keeps 8; imports pass the "Import: summaries at once" setting. */
  constructor(source: string | { directory: string; store: Store; saved: Saved }, private readonly compress: Compressor,
    private readonly warn: (s: string) => void = console.error,
    readonly budget = VIEW, private readonly jobs = 8, private readonly retryMs?: number, defer = 1) {
    this.chat = new Sawtooth(budget, budget / 2, part => this.node(part), budget * Math.max(1, defer));
    this.compaction = new Sawtooth(budget / 4, budget / 8, part => this.node(part));
    let saved: Saved;
    if (typeof source === 'string') { const store = new FileStore(source, warn); this.directory = source; this.store = store; saved = store.load(); }
    else ({ directory: this.directory, store: this.store, saved } = source);
    const log = saved.entries;
    const entries = log.every(isEntry) ? log.sort((a, b) => a.i - b.i) : undefined;
    if (!entries || entries.some((entry, i) => entry.i !== i)) throw new Error('Invalid/noncontiguous OptChat log; refusing to change it.');
    for (const value of entries) this.root.push({ ...value, size: bytes(`${value.kind}: ${value.text}`) });
    this.loadTree(saved.tree);
    for (const node of this.tree.values()) this.queueParent(node);
    for (let i = 0; i < this.root.length; i++) if (!this.node({ l: 0, i })) this.unbuilt.add(i);
    // Refolding the log gives a different view than the live one, and every cache entry would miss, so the view is saved.
    const loaded = this.load(saved.view);
    for (const part of this.view) this.compaction.push(part);
    this.compaction.fit(loaded, true);
    for (let i = loaded; i < this.root.length; i++) { this.push(i); this.fit(i + 1); }
    this.fit(); this.save(); this.schedule();
  }
  private loadTree(records: unknown[]) {
    for (const value of records) if (!isSummary(value) && !isTerminalRecord(value)) this.warn('Skipped an invalid OptChat summary record.');
    this.loadSummaries(records.filter(isSummary).sort((a, b) => a.l - b.l || a.i - b.i));
    this.loadTerminalRecords(records.filter(isTerminalRecord));
  }
  private loadSummaries(summaries: Summary[]) {
    for (const value of summaries) {
      const children = value.l === 0 || (this.tree.has(key({ l: value.l - 1, i: 2 * value.i })) && this.tree.has(key({ l: value.l - 1, i: 2 * value.i + 1 })));
      if (value.l < 0 || value.i < 0 || !value.text.trim() || end(value) > this.root.length || !children || this.tree.has(key(value))) {
        this.warn('Skipped an incomplete or invalid OptChat summary record.');
        continue;
      }
      this.tree.set(key(value), { ...value, size: lineBytes(value.text) });
    }
  }
  private loadTerminalRecords(records: TerminalRecord[]) {
    for (const value of records) {
      const part = { l: value.l, i: value.i };
      const children = part.l === 0 || (this.node({ l: part.l - 1, i: 2 * part.i }) && this.node({ l: part.l - 1, i: 2 * part.i + 1 }));
      if (part.l < 0 || part.i < 0 || end(part) > this.root.length || !children) {
        this.warn('Skipped an invalid OptChat terminal record.');
        continue;
      }
      if (value.type === 'terminal') this.terminal.set(key(part), value.code);
      else this.terminal.delete(key(part));
    }
    for (const id of this.terminal.keys()) if (this.tree.has(id)) this.terminal.delete(id);
    if (this.terminal.size) this.lastError = 'Summary blocked by policy refusal; explicit retry required.';
  }
  append(kind: Kind, text: string, date = new Date().toISOString(), receipt?: string, origin?: Origin) {
    if (this.stopped) throw new Error('Memory is closed.');
    if (this.failed) throw new Error(`Memory could not be saved: ${this.failed}`);
    const entry: Entry = { i: this.root.length, kind, text, date, size: bytes(`${kind}: ${text}`), ...(receipt ? { receipt } : {}), ...(origin ? { origin } : {}) };
    this.clearSearchCache();
    // New messages retry ordinary failures, but policy refusals stay blocked until an explicit retry action.
    this.retryAt.clear();
    void this.enqueue(() => this.store.append(entry), error => {
      this.failed ??= error instanceof Error ? error.message : String(error);
      this.warn(`Memory could not be saved: ${this.failed}`);
    });
    this.root.push(entry); this.push(entry.i); if (this.fit()) this.save(); this.schedule();
    return entry;
  }
  node(part: Part) { return this.tree.get(key(part)); }
  /** Explicitly reset a policy-refused node; normal appends never clear this terminal block. */
  async retryRefused(part: Part) {
    if (this.stopped) throw new Error('Memory is closed.');
    if (!Number.isSafeInteger(part.l) || !Number.isSafeInteger(part.i) || part.l < 0 || part.i < 0 || end(part) > this.root.length) return false;
    const id = key(part);
    if (!this.terminal.has(id)) return false;
    if (this.failed) throw new Error(`Memory could not be saved: ${this.failed}`);
    await this.writeTerminal(part, 'retry');
    if (this.failed) return false;
    this.terminal.delete(id); this.reported.delete(id);
    if (!this.terminal.size && !this.retryAt.size) this.lastError = undefined;
    this.schedule(); this.events.emit('change');
    return true;
  }
  private text(part: Part) { return this.node(part)?.text ?? UNBUILT; }
  /** Runs a store write at once when none is running, so a store that finishes its writes as it returns (FileStore) throws here
   * as before; otherwise after the running ones, so writes land in the order Memory makes them. Returns the queued write, settled
   * through `failed`, unless it finished at once. */
  private enqueue(write: () => Promise<void> | undefined, failed: (error: unknown) => void) {
    const run = () => this.failed ? undefined : write();
    const started = this.writing ? this.writing.then(run) : run();
    if (!started) return;
    const settled = started.catch(failed);
    const tail: Promise<void> = settled.catch(() => {}).then(() => { if (this.writing === tail) this.writing = undefined; });
    this.writing = tail;
    return settled;
  }
  private async writeTerminal(part: Part, type: TerminalRecord['type']) {
    if (!this.store.appendTerminal) {
      this.warn('This store cannot persist policy-refusal state; the node may be retried after reopening.');
      return;
    }
    const record: TerminalRecord = { type, ...part, code: POLICY_REFUSAL };
    const written = this.enqueue(() => this.store.appendTerminal!(record), () => {
      this.failed ??= 'Could not persist policy-refusal state.';
      this.warn('Could not persist policy-refusal state; automatic retries remain disabled only in this session.');
    });
    if (written) await written;
  }
  /** Takes the saved view if it still tiles the log from the start, and returns how many messages it covers. */
  private load(view: string | undefined) {
    if (view === undefined) return 0;
    const rebuild = () => { this.warn('Rebuilt the memory view: the saved one does not match the log.'); return 0; };
    let saved: unknown;
    try { saved = JSON.parse(view); } catch { return rebuild(); }
    const merging = object(saved) && saved.merging === true;
    if (object(saved) && typeof saved.merging === 'boolean') saved = saved.parts;
    if (!Array.isArray(saved)) return rebuild();
    const parts: Part[] = [];
    let covered = 0;
    for (const value of saved) {
      const [l, i] = Array.isArray(value) ? value : [];
      const part = { l, i };
      if (!Number.isSafeInteger(l) || !Number.isSafeInteger(i) || l < 0 || start(part) !== covered || end(part) > this.root.length || (l > 0 && !this.node(part)))
        return rebuild();
      parts.push(part); covered = end(part);
    }
    for (const part of parts) this.chat.push(part);
    this.chat.merging = merging;
    return covered;
  }
  /** Saved when it merges or changes batch state: a view that only grew is the saved one plus later messages, as `load` replays it.
   * The log stays authoritative, so a failed save only warns. */
  private save() {
    const failed = (error: unknown) => { this.warn(`Could not save the memory view: ${error instanceof Error ? error.message : String(error)}`); };
    try { void this.enqueue(() => this.store.saveView(JSON.stringify({ parts: this.view.map(p => [p.l, p.i]), merging: this.chat.merging })), failed); }
    catch (error) { failed(error); }
  }
  private push(i: number) {
    const part = { l: 0, i };
    this.chat.push(part); this.compaction.push(part);
    if (!this.node(part)) this.unbuilt.add(i);
  }
  get view(): readonly Part[] { return this.chat.parts; }
  render() { return `${VIEW_OPEN}${this.view.map(p => `${start(p)}+${2 ** p.l}|${flat(this.text(p))}`).join('\n')}\n</chat>`; }
  get ready() { return this.view.every(p => this.node(p)); }
  get pending() { return this.unbuilt.size; }
  get active() { return this.busy.size; }
  get size() { return this.chat.size; }
  /** Summaries built out of the backlog since it was last empty, and when the next failed one is retried. */
  progress(now = Date.now()) {
    const due = Math.min(...[...this.retryAt.values()].filter(t => t > now));
    return { done: this.peak - this.owed(), total: this.peak, retryIn: Number.isFinite(due) ? due - now : undefined };
  }
  private owed() { return this.expectedNodes() - this.tree.size; }
  onChange(listener: () => void) { this.events.on('change', listener); return () => { this.events.off('change', listener); }; }
  /** The view line covering message `at`. */
  covering(at: number) { return this.chat.covering(at); }
  /** The prompt cache has expired: start the batch merge the view put off, if it is over budget. Returns whether the view merged. */
  cool() {
    const merged = this.fit(this.root.length, true);
    if (merged) this.save();
    return merged;
  }
  /** Returns whether the chat's view or batch state changed. */
  private fit(total = this.root.length, cold = false) {
    const merging = this.chat.merging;
    const merged = this.chat.fit(total, false, cold);
    this.compaction.fit(total, merged);
    const owed = this.owed();
    this.peak = owed > 0 ? Math.max(this.peak, owed) : 0;
    this.events.emit('change');
    return merged || merging !== this.chat.merging;
  }
  private schedule() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump() {
    if (this.stopped) return;
    // One clock reading: skipping a part and arming its retry timer must agree on what is due.
    const now = Date.now();
    const run = (part: Part) => {
      const id = key(part);
      if (this.busy.has(id) || this.terminal.has(id) || (this.retryAt.get(id) ?? 0) > now) return;
      // Schedule before telling waiters, so a turn never mistakes the gap before the next pump for a stall.
      const promise = this.build(part).catch(error => this.handleFailure(part, error))
        .finally(() => { this.busy.delete(id); this.schedule(); this.events.emit('change'); });
      this.busy.set(id, promise);
    };
    // A message's node starts once fewer than `jobs` lines before it are unbuilt; a merge, once both halves are built.
    let ahead = 0;
    for (const i of this.unbuilt) {
      if (ahead++ === this.jobs) break;
      if (this.busy.size >= this.jobs) return;
      if (!this.flushing && this.awaitingResult(i)) continue;
      run({ l: 0, i });
    }
    for (const part of this.merges.values()) {
      if (this.busy.size >= this.jobs) return;
      run(part);
    }
    // A later failure can have a later deadline than the timer installed by the first.
    const deadlines = [...this.retryAt.values()].filter(t => t > now && Number.isFinite(t));
    if (deadlines.length && !this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.schedule(); }, Math.max(1, Math.min(...deadlines) - now));
    if (this.stalled) this.events.emit('change');
  }
  private async handleFailure(part: Part, error: unknown) {
    if (this.stopped) return;
    const id = key(part), refused = isPolicyRefusal(error);
    this.lastError = refused ? 'Summary blocked by policy refusal; explicit retry required.'
      : error instanceof Error ? error.message : String(error);
    if (!this.reported.has(id)) { this.reported.add(id); this.warn(`Compactor ${start(part)}+${2 ** part.l}: ${this.lastError}`); }
    if (refused) {
      this.terminal.set(id, POLICY_REFUSAL); this.retryAt.delete(id);
      await this.writeTerminal(part, 'terminal');
    } else {
      this.retryAt.set(id, this.retryMs ? Date.now() + this.retryMs : Infinity);
      if (this.retryMs && !this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.schedule(); }, this.retryMs);
    }
  }
  /** Nothing is being built, nothing more can start, and a failed or explicitly blocked node prevents progress. */
  private get stalled() { return this.busy.size === 0 && !this.scheduled && (this.retryAt.size > 0 || this.terminal.size > 0); }
  /** The results logged for a run of parallel calls follow it in call order: tool A, tool B, echo A, echo B. */
  private resultOf(i: number) {
    let first = i, last = i;
    while (this.root[first - 1]?.kind === 'tool') first--;
    while (this.root[last + 1]?.kind === 'tool') last++;
    const echo = this.root[last + 1 + i - first];
    return echo?.kind === 'echo' ? echo.text : undefined;
  }
  /** A call's summary waits for its result, while only calls and results follow it. */
  private awaitingResult(i: number) {
    if (this.root[i].kind !== 'tool' || this.resultOf(i) !== undefined) return false;
    for (let j = i + 1; j < this.root.length; j++) if (this.root[j].kind !== 'tool' && this.root[j].kind !== 'echo') return false;
    return true;
  }
  private async build(part: Part) {
    const source = part.l === 0 ? `${this.root[part.i].kind}: ${this.root[part.i].text}`
      : [0, 1].map(offset => this.text({ l: part.l - 1, i: 2 * part.i + offset })).join('\n');
    const mergeSource = part.l > 0 ? [0, 1].map(offset => flat(this.text({ l: part.l - 1, i: 2 * part.i + offset }))).join('\n')
      : this.root[part.i].kind === 'echo' ? cap(source) : source;
    const result = part.l === 0 && this.root[part.i].kind === 'tool' ? this.resultOf(part.i) : undefined;
    const call = part.l === 0 ? this.callOf(part.i) : undefined;
    let text = bytes(source) <= NODE ? source : (await this.compress({ context: this.compactionView(part), source: mergeSource, part,
      historical: this.root.slice(start(part), end(part)).some(entry => !!entry.origin),
      ...(result === undefined ? {} : { result: cap(result, RESULT) }),
      ...(call ? { call: { i: call.i, text: cap(`tool: ${call.text}`, 4000) } } : {}) }, this.controller.signal)).trim();
    // A model may copy a differently tagged line from <chat>; the source message keeps its own kind.
    if (text && part.l === 0 && text !== source) text = labeled(this.root[part.i].kind, text);
    if (this.stopped) return;
    if (!text) throw new Error('Compactor returned an empty summary.');
    const node = { ...part, text, size: lineBytes(text) };
    // A failed node write fails the build, which is retried.
    const written = this.enqueue(() => this.store.appendNode(node), error => { throw error; });
    if (written) await written;
    this.tree.set(key(part), node); this.retryAt.delete(key(part)); this.merges.delete(key(part)); this.queueParent(part);
    if (!part.l) { this.unbuilt.delete(part.i); this.chat.built(part.i); this.compaction.built(part.i); }
    if (!this.retryAt.size && !this.terminal.size) this.lastError = undefined;
    if (this.fit()) this.save();
  }
  /** The tool call a result answers: a run of calls is followed by their results in the same order. A result that doesn't
   * start with the call's tool name (an `Agent error`, an odd import) has none. */
  private callOf(i: number) {
    if (this.root[i].kind !== 'echo') return;
    let results = i;
    while (this.root[results - 1]?.kind === 'echo') results--;
    let calls = results;
    while (this.root[calls - 1]?.kind === 'tool') calls--;
    const call = calls + i - results < results ? this.root[calls + i - results] : undefined;
    return call && this.root[i].text.startsWith(`${call.text.split(' ', 1)[0]}:`) ? call : undefined;
  }
  /** The compactions' view ends before the first unbuilt line so an unbuilt placeholder cannot distort a summary. */
  private compactionView(part: Part) {
    const boundary = part.l === 0 ? start(part) : end(part), lines: string[] = [];
    for (const p of this.compaction.parts) { if (end(p) > boundary || !this.node(p)) break; lines.push(`${start(p)}+${2 ** p.l}|${flat(this.text(p))}`); }
    return `${VIEW_OPEN}${lines.join('\n')}\n</chat>`;
  }
  private queueParent({ l, i }: Part) {
    const parent = { l: l + 1, i: Math.floor(i / 2) };
    if (!this.node(parent) && this.node({ l, i: i % 2 ? i - 1 : i + 1 })) this.merges.set(key(parent), parent);
  }
  /** A 'turn' waits until every part of the view is built, or until everything pending has failed: it then goes on with placeholders
   * for the missing lines, `lastError` says why, and failed nodes stay available for retry. 'tree' waits through retryable failures,
   * but rejects if a policy refusal makes the complete tree impossible. As in the recipe, the view may run over budget until pending
   * merges land. 'ahead' (imports) waits until a new message's node would start at once. Due merges count too: messages go first, so
   * a steady stream of them would otherwise take every worker and the views could never merge; it rejects if a policy refusal leaves
   * no work that can make the threshold. */
  private isWaitBlocked(until: 'turn' | 'tree' | 'ahead') {
    return this.terminal.size > 0 && (until === 'tree'
      || until === 'ahead' && this.busy.size === 0 && !this.scheduled && !this.retryTimer);
  }
  async settle(signal?: AbortSignal, until: 'turn' | 'tree' | 'ahead' = 'turn'): Promise<void> {
    const done = () => until === 'tree' ? this.ready && this.busy.size === 0 && this.tree.size === this.expectedNodes()
      : until === 'ahead' ? this.unbuilt.size + this.merges.size < this.jobs
      : this.ready || this.stalled;
    const blockedError = () => new Error('Memory wait blocked by policy refusal; explicit retry required.');
    if (done()) return;
    if (this.stopped || signal?.aborted) throw new Error('Memory wait cancelled.');
    if (this.isWaitBlocked(until)) throw blockedError();
    const flush = until !== 'ahead';
    if (flush) { this.flushing++; this.schedule(); }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { if (flush) this.flushing--; this.events.off('change', check); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new Error('Memory wait cancelled.')); };
      const check = () => {
        if (this.stopped) abort();
        else if (done()) { cleanup(); resolve(); }
        else if (this.isWaitBlocked(until)) { cleanup(); reject(blockedError()); }
      };
      this.events.on('change', check); signal?.addEventListener('abort', abort, { once: true }); check();
    });
  }
  private expectedNodes() {
    let count = 0;
    for (let n = this.root.length; n > 0; n = Math.floor(n / 2)) count += n;
    return count;
  }
  /** n = 1 gives the message whole, or, when it is longer than `limit` or `offset` is given, the page of up to `limit` characters from `offset`. */
  zoom(id: number, n: number, offset?: number, limit?: number) {
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(n) || n < 1 || !Number.isInteger(Math.log2(n)) || id % n || id + n > this.root.length)
      throw noLine(id, n, this.root.length);
    if (n === 1) {
      const { kind, text } = this.root[id], page = Math.min(limit ?? PAGE, PAGE);
      if (!Number.isSafeInteger(page) || page < 1) throw new Error('limit must be a positive integer.');
      if (offset === undefined && text.length <= page) return `${id}+1|${kind}: ${text}`;
      if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset >= Math.max(1, text.length)))
        throw new Error(`Message ${id} has ${text.length} characters; offset must be 0 to ${Math.max(0, text.length - 1)}.`);
      // Never split a surrogate pair: a page starts on its first half and ends after its second.
      const from = /[\udc00-\udfff]/.test(text[offset ?? 0] ?? '') ? (offset ?? 0) - 1 : offset ?? 0;
      let to = Math.min(text.length, from + page);
      // A one-unit page on a pair takes the whole pair, so the next offset always moves forward.
      if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1])) to += to - 1 === from ? 1 : -1;
      const hint = text.length <= PAGE ? `\n[note: this message is only ${text.length.toLocaleString('en-US')} characters and fits in one zoom; offset/limit are for messages over ${PAGE.toLocaleString('en-US')}]` : '';
      return `${id}+1|${kind}: ${text.slice(from, to)}\n[showing characters ${from}-${to} of ${text.length}${to < text.length ? `; next page: offset ${to}` : ''}]${hint}`;
    }
    if (offset !== undefined) throw new Error('offset and limit page one message: use them with n = 1.');
    const l = Math.log2(n) - 1, i = 2 * id / n;
    return [0, 1].map(offset => {
      const part = { l, i: i + offset }, node = this.node(part);
      if (!node) throw new Error('This range is not summarized yet.');
      return `${start(part)}+${2 ** l}|${flat(node.text)}`;
    }).join('\n');
  }
  private clearSearchCache() { this.searchCache.clear(); this.searchCacheHits = 0; }
  private cacheSearch(needle: string, hits: readonly Entry[]) {
    if (!needle || needle.length > SEARCH_CACHE_QUERY_CHARS || hits.length > SEARCH_CACHE_HITS) return;
    const indexes = hits.map(entry => entry.i);
    while (this.searchCache.size >= SEARCH_CACHE_QUERIES || this.searchCacheHits + indexes.length > SEARCH_CACHE_HITS) {
      const oldest = this.searchCache.keys().next().value;
      if (oldest === undefined) break;
      this.searchCacheHits -= this.searchCache.get(oldest)!.length;
      this.searchCache.delete(oldest);
    }
    this.searchCache.set(needle, indexes);
    this.searchCacheHits += indexes.length;
  }
  /** Original messages containing `text`, ignoring case, newest first, older than message `before`. Never summaries,
   * nor the logged zoom/search calls and results, which only copy memory. Tree changes do not affect original-message hits. */
  search(text: string, before = this.root.length) {
    const needle = text.toLowerCase(), limit = Math.min(before, this.root.length), cached = this.searchCache.get(needle);
    if (cached) {
      this.searchCache.delete(needle); this.searchCache.set(needle, cached);
      const page: Entry[] = [];
      for (const i of cached) if (i < limit) page.push(this.root[i]);
      return page;
    }
    const hits: Entry[] = [];
    for (let i = limit - 1; i >= 0; i--) {
      const entry = this.root[i];
      if ((entry.kind === 'tool' || entry.kind === 'echo') && /^(zoom|search)[ :]/.test(entry.text)) continue;
      if (entry.text.toLowerCase().includes(needle)) hits.push(entry);
    }
    if (limit === this.root.length) this.cacheSearch(needle, hits);
    return hits;
  }
  date(id: number) {
    if (!Number.isSafeInteger(id) || !this.root[id]) throw new Error(`No message ${id}. ${messageScope(this.root.length)}${this.root.length ? '.' : ''}`);
    return new Date(this.root[id].date).toString();
  }
  async close() {
    this.stopped = true; this.controller.abort(); clearTimeout(this.retryTimer);
    this.events.emit('change'); await Promise.allSettled(this.busy.values()); await this.writing;
  }
}
