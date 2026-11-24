import { EventEmitter } from 'node:events';
import { FileStore, type ColdSummaryRecord, type Saved, type Store, type TerminalRecord } from './store.ts';
import { runSliced, runSync, sortSteps } from './sliced.ts';
import { scrubSecrets } from './secret-scrub.ts';

export const NODE = 512;
export const VIEW = 128_000;
/** While the prompt cache is warm the chat view puts off its batch merge until it reaches this many times its budget, since
 * the batch rewrites the view from near its top and the next request misses the cache. */
export const DEFER = 1.5;
/** A turn starting this long after the last request finds the provider's 5-minute cache expired, so merging then costs nothing. */
export const COLD_MS = 270_000;
/** With the view's older mark on the 1-hour entry (cache.ts), the batch waits as long as that entry lives: merging sooner rewrites
 * the view under it and throws away the 1-hour write. Same 30-second margin as COLD_MS. */
export const COLD_LONG_MS = 3_570_000;
export const CAP = 30_000;
/** The most characters one zoom into a message returns, so a page stays under the tool output CAP instead of losing its middle. */
export const PAGE = 25_000;
export const KINDS = ['user', 'talk', 'tool', 'echo', 'note', 'work'] as const;
export type Kind = typeof KINDS[number];
export interface Origin { source: 'claude' | 'claude-memory' | 'codex' | 'pi' | 'chatgpt'; conversation: string; message: string; title: string; project?: string }
export interface Entry { i: number; kind: Kind; text: string; size: number; date: string; receipt?: string; origin?: Origin }
export interface Part { l: number; i: number }
/** `revised`: a later record that replaces a built line's text (Memory.revise); the first record of a part builds it. */
export interface Summary extends Part { text: string; size: number; revised?: true }
/** `part` is the node to build: a message's leaf, or the merge of its two halves. A tool result can carry the call it answers;
 * a call can carry its output once available, so its summary preserves what it found. */
export interface Compression { context: string; source: string; part: Part; historical?: boolean; result?: string; call?: { i: number; text: string }; revise?: string }
export type Compressor = (input: Compression, signal: AbortSignal) => Promise<string>;
const key = ({ l, i }: Part) => l * 2 ** 40 + i;
const POLICY_REFUSAL = 'OPTCHAT_POLICY_REFUSAL' as const;
const UNBUILT = '(not summarized yet: zoom it)';
const HEAD = 400;
export const start = ({ l, i }: Part) => i * 2 ** l;
export const end = (part: Part) => start(part) + 2 ** part.l;
export const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

const RESULT = 12_000;

/** The newest messages keep their text in RAM, bounded by both count and UTF-8 bytes; older summarized ones are read back from the store when asked for. */
export const HOT_TEXTS = 2048;
export const HOT_TEXT_BYTES = 2 * 1024 * 1024;
const SEARCH_CACHE_QUERIES = 8;
const SEARCH_CACHE_HITS = 20_000;
const SEARCH_CACHE_QUERY_CHARS = 256;

interface HitIndex { scanned: number; hits: number[] }
const KIND_HEAD = new RegExp(`^\\s*(?:${KINDS.join('|')})\\s*:\\s*`, 'i');
/** A cheap model can head a summary with the kind of a <chat> line it copied, so the code sets the message's own. */
export const labeled = (kind: Kind, text: string) => `${kind}: ${text.replace(KIND_HEAD, '')}`;
export const flat = (s: string) => s.replace(/[\r\n]+/g, ' ');
function unbuiltHead(text: string) {
  const line = flat(text);
  if (bytes(line) <= HEAD) return line;
  let head = '', size = 0;
  for (const char of line) {
    const n = bytes(char);
    if (size + n > HEAD) break;
    head += char; size += n;
  }
  return `${head} …${UNBUILT}`;
}
const messageScope = (count: number) => count === 0 ? 'Memory has no messages yet.' : `Messages run 0-${count - 1}`;
/** The aligned blocks id+n (n a power of two, as zoom requires) that tile messages from..to-1, oldest first. */
export function alignedBlocks(from: number, to: number) {
  const tiles: { id: number; n: number }[] = [];
  for (let at = from; at < to;) {
    let n = 1;
    while (at % (n * 2) === 0 && at + n * 2 <= to) n *= 2;
    tiles.push({ id: at, n }); at += n;
  }
  return tiles;
}
const HINT_BLOCKS = 6;

function alignedHint(id: number, n: number, count: number) {
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(n) || id < 0 || n < 1 || id >= count) return '';
  const to = Math.min(id + n, count);
  const tiles = alignedBlocks(id, to);
  const shown = tiles.slice(0, HINT_BLOCKS).map(t => `${t.id}+${t.n}`).join(', ');
  return ` To read messages ${id}-${to - 1} zoom: ${shown}${tiles.length > HINT_BLOCKS ? `, and ${tiles.length - HINT_BLOCKS} more` : ''}.`;
}
/** The error for a zoom range that does not exist, naming the ranges that do. */
export const noLine = (id: number, n: number, count: number) => new Error(`No line ${id}+${n}. ${count === 0 ? messageScope(count)
  : `${messageScope(count)}; n is a power of two, id a multiple of n, id+n at most ${count}.${alignedHint(id, n, count)}`}`);
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



class Sawtooth {
  readonly parts: Part[] = [];
  private measured = 0;
  merging = false;
  constructor(private readonly high: number, private readonly low: number, private readonly node: (part: Part) => Summary | undefined,
    private readonly unbuilt: (i: number) => string, private readonly ceiling = high) {}
  private lineSize(part: Part) { return bytes(`${start(part)}+${2 ** part.l}|\n`) + (this.node(part)?.size ?? bytes(this.unbuilt(part.i))); }
  get size() { return VIEW_FRAME_BYTES + this.measured + (this.parts.length ? 0 : 1); }
  push(part: Part) { this.parts.push(part); this.measured += this.lineSize(part); }

  covering(at: number): Part | undefined {
    for (let lo = 0, hi = this.parts.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1, p = this.parts[mid];
      if (end(p) <= at) lo = mid + 1;
      else if (start(p) > at) hi = mid - 1;
      else return p;
    }
  }

  resized(part: Part, delta: number) { if (this.parts.some(p => p.l === part.l && p.i === part.i)) this.measured += delta; }

  built(i: number) { if (this.covering(i)?.l === 0) this.measured += this.node({ l: 0, i })!.size - bytes(this.unbuilt(i)); }

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
const FLAG_ORIGIN = 1;
const FLAG_RECEIPT = 2;
const KIND_INDEX = new Map<Kind, number>(KINDS.map((k, i) => [k, i]));


class ColdIndex {
  private kinds = new Uint8Array(0);
  private sizes = new Uint32Array(0);
  private dates = new Float64Array(0);
  private flags = new Uint8Array(0);
  private extraDates?: Map<number, string>;
  private receipts?: Map<number, string>;
  private origins?: Map<number, Origin>;
  constructor(readonly store: Store) {}

  reserve(capacity: number) {
    if (capacity <= this.kinds.length) return;
    const nextKinds = new Uint8Array(capacity); nextKinds.set(this.kinds); this.kinds = nextKinds;
    const nextSizes = new Uint32Array(capacity); nextSizes.set(this.sizes); this.sizes = nextSizes;
    const nextDates = new Float64Array(capacity); nextDates.set(this.dates); this.dates = nextDates;
    const nextFlags = new Uint8Array(capacity); nextFlags.set(this.flags); this.flags = nextFlags;
  }
  set(entry: Entry) {
    const i = entry.i;
    if (i >= this.kinds.length) {
      this.reserve(Math.max(i + 1, this.kinds.length ? this.kinds.length * 2 : 1024));
    }
    this.kinds[i] = KIND_INDEX.get(entry.kind) ?? 0;
    this.sizes[i] = entry.size;
    const ms = Date.parse(entry.date);
    if (!Number.isNaN(ms) && new Date(ms).toISOString() === entry.date) {
      this.dates[i] = ms;
    } else {
      this.dates[i] = Number.NaN;
      (this.extraDates ??= new Map()).set(i, entry.date);
    }
    let f = 0;
    if (entry.origin) {
      f |= FLAG_ORIGIN;
      if (!this.store.readRecord) (this.origins ??= new Map()).set(i, entry.origin);
    }
    if (entry.receipt) {
      f |= FLAG_RECEIPT;
      (this.receipts ??= new Map()).set(i, entry.receipt);
    }
    this.flags[i] = f;
  }

  kind(i: number): Kind { return KINDS[this.kinds[i]]; }
  size(i: number): number { return this.sizes[i]; }
  date(i: number): string {
    const ms = this.dates[i];
    return Number.isNaN(ms) ? (this.extraDates?.get(i) ?? '') : new Date(ms).toISOString();
  }
  hasOrigin(i: number): boolean { return (this.flags[i] & FLAG_ORIGIN) !== 0; }
  receipt(i: number): string | undefined { return (this.flags[i] & FLAG_RECEIPT) !== 0 ? this.receipts?.get(i) : undefined; }
  origin(i: number): Origin | undefined {
    if ((this.flags[i] & FLAG_ORIGIN) === 0) return undefined;
    if (this.origins?.has(i)) return this.origins.get(i);
    const rec = this.store.readRecord?.(i);
    return rec && object(rec.origin) ? (rec.origin as unknown as Origin) : undefined;
  }
  text(i: number): string { return this.store.reader?.(i)?.() ?? ''; }
}


class ColdEntry implements Entry {
  constructor(readonly i: number, private readonly cold: ColdIndex) {}
  get kind(): Kind { return this.cold.kind(this.i); }
  get size(): number { return this.cold.size(this.i); }
  get date(): string { return this.cold.date(this.i); }
  get receipt(): string | undefined { return this.cold.receipt(this.i); }
  get origin(): Origin | undefined { return this.cold.origin(this.i); }
  get text(): string { return this.cold.text(this.i); }
  toJSON() {
    const receipt = this.receipt, origin = this.origin;
    return { i: this.i, kind: this.kind, text: this.text, size: this.size, date: this.date, ...(receipt ? { receipt } : {}), ...(origin ? { origin } : {}) };
  }
}

function isColdRecord(value: unknown): boolean {
  return object(value) && !('text' in value) && Number.isSafeInteger(value.i) && KINDS.some(kind => kind === value.kind)
    && typeof value.size === 'number' && typeof value.date === 'string';
}

class ColdSummary implements Summary {
  constructor(readonly l: number, readonly i: number, readonly size: number, private readonly store: Store) {}
  get text() { return this.store.nodeText!(this.l, this.i); }
}
const MAX_TREE_LEVEL = 32;
const MAX_TREE_INDEX = 10_000_000;

class ColdTreeMap implements Map<number, Summary> {
  private readonly warm = new Map<number, Summary>();
  private readonly coldLevels: Uint32Array[] = [];
  private coldCount = 0;
  constructor(private readonly store: Store) {}
  get size() { return this.warm.size + this.coldCount; }
  get warmSize() { return this.warm.size; }
  get coldSize() { return this.coldCount; }
  warmValues() { return this.warm.values(); }
  has(k: number) {
    if (this.warm.has(k)) return true;
    const l = Math.floor(k / 2 ** 40), i = k - l * 2 ** 40;
    return l >= 0 && l < this.coldLevels.length && i >= 0 && i < (this.coldLevels[l]?.length ?? 0) && this.coldLevels[l][i] !== 0;
  }
  get(k: number): Summary | undefined {
    const w = this.warm.get(k);
    if (w !== undefined) return w;
    const l = Math.floor(k / 2 ** 40), i = k - l * 2 ** 40;
    if (l >= 0 && l < this.coldLevels.length && i >= 0 && i < (this.coldLevels[l]?.length ?? 0)) {
      const v = this.coldLevels[l][i];
      if (v !== 0) return new ColdSummary(l, i, v - 1, this.store);
    }
    return undefined;
  }
  set(k: number, value: Summary) {
    if (value instanceof ColdSummary && value.l >= 0 && value.l < MAX_TREE_LEVEL && value.i >= 0 && value.i < MAX_TREE_INDEX
      && value.size >= 0 && value.size < 0xffffffff && k === value.l * 2 ** 40 + value.i) {
      this.warm.delete(k);
      let level = this.coldLevels[value.l];
      if (!level || value.i >= level.length) {
        const next = new Uint32Array(Math.max(value.i + 1, level ? level.length * 2 : 1024));
        if (level) next.set(level);
        level = this.coldLevels[value.l] = next;
      }
      if (level[value.i] === 0) this.coldCount++;
      level[value.i] = value.size + 1;
      return this;
    }
    const l = Math.floor(k / 2 ** 40), i = k - l * 2 ** 40;
    if (l >= 0 && l < this.coldLevels.length && i >= 0 && i < (this.coldLevels[l]?.length ?? 0) && this.coldLevels[l][i] !== 0) {
      this.coldLevels[l][i] = 0;
      this.coldCount--;
    }
    this.warm.set(k, value);
    return this;
  }
  delete(k: number) {
    let removed = this.warm.delete(k);
    const l = Math.floor(k / 2 ** 40), i = k - l * 2 ** 40;
    if (l >= 0 && l < this.coldLevels.length && i >= 0 && i < (this.coldLevels[l]?.length ?? 0) && this.coldLevels[l][i] !== 0) {
      this.coldLevels[l][i] = 0;
      this.coldCount--;
      removed = true;
    }
    return removed;
  }
  clear() { this.warm.clear(); this.coldLevels.length = 0; this.coldCount = 0; }
  *entries(): MapIterator<[number, Summary]> {
    yield* this.warm.entries();
    for (let l = 0; l < this.coldLevels.length; l++) {
      const level = this.coldLevels[l];
      if (!level) continue;
      for (let i = 0; i < level.length; i++) if (level[i] !== 0) yield [l * 2 ** 40 + i, new ColdSummary(l, i, level[i] - 1, this.store)];
    }
  }
  *keys(): MapIterator<number> { for (const [k] of this.entries()) yield k; }
  *values(): MapIterator<Summary> {
    yield* this.warm.values();
    for (let l = 0; l < this.coldLevels.length; l++) {
      const level = this.coldLevels[l];
      if (!level) continue;
      for (let i = 0; i < level.length; i++) if (level[i] !== 0) yield new ColdSummary(l, i, level[i] - 1, this.store);
    }
  }
  forEach(cb: (value: Summary, key: number, map: Map<number, Summary>) => void, thisArg?: unknown) {
    for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this);
  }
  [Symbol.iterator]() { return this.entries(); }
  readonly [Symbol.toStringTag] = 'Map';
}
function isSummary(value: unknown): value is Summary {
  return object(value) && Number.isSafeInteger(value.l) && Number.isSafeInteger(value.i)
    && typeof value.text === 'string';
}
function isColdSummary(value: unknown): value is ColdSummaryRecord {
  return object(value) && !('text' in value) && Number.isSafeInteger(value.l) && Number.isSafeInteger(value.i)
    && typeof value.size === 'number' && value.size > 0;
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
  readonly tree: ColdTreeMap;
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
  /** Hit indexes per lowercased query, extended as messages arrive; `before` pages filter this bounded result. */
  private readonly searchCache = new Map<string, HitIndex>();
  /** What this memory holds in RAM, for diagnostics only: counts and byte sizes, never text. */
  stats() {
    let liveTexts = 0, liveTextBytes = 0;
    for (const entry of this.root) if (Object.getOwnPropertyDescriptor(entry, 'text')?.writable) { liveTexts++; liveTextBytes += Buffer.byteLength(entry.text); }

    let treeTextBytes = 0, treeColdNodes = this.tree.coldSize;
    for (const node of this.tree.warmValues()) {
      if (Object.getOwnPropertyDescriptor(node, 'text')) treeTextBytes += Buffer.byteLength(node.text); else treeColdNodes++;
    }
    let searchCacheHits = 0;
    for (const held of this.searchCache.values()) searchCacheHits += held.hits.length;
    return { root: this.root.length, liveTexts, liveTextBytes, treeNodes: this.tree.size, treeColdNodes, treeTextBytes, storeLines: this.store.lineIndexSize?.() ?? 0,
      searchCacheQueries: this.searchCache.size, searchCacheHits, unbuilt: this.unbuilt.size };
  }
  /** Messages examined by search so far; tests read it to prove a repeated query does not rescan history. */
  private scans = 0;
  get searchScans() { return this.scans; }
  /** The last store write still running, if any. Once an append fails, later writes are skipped and appends throw, as after a failed file write. */
  private writing?: Promise<void>;
  private failed?: string;
  /** Where this memory's local files live: all of it for a FileStore, and the browser page, runs and imports for any store. */
  readonly directory: string;
  readonly store: Store;
  private readonly cold: ColdIndex;
  private hotBytes = 0;
  private unbuiltHotBytes = 0;
  private hotCursor = 0;
  lastError?: string;

  /** Resolves only when the complete memory is ready for use. */
  static async open(directory: string, compress: Compressor, warn: (s: string) => void = console.error, budget = VIEW, jobs = 8, retryMs?: number, defer = 1) {
    const store = new FileStore(directory, warn), saved = await store.loadAsync(HOT_TEXTS, HOT_TEXT_BYTES);
    const memory = new Memory({ directory, store, saved }, compress, warn, budget, jobs, retryMs, defer, true);
    await runSliced(memory.initialize(saved));
    return memory;
  }
  /** A directory alone opens a FileStore there. `jobs`: summaries built at once, and how many unbuilt lines a new message's node
   * waits behind. Chat keeps 8; imports pass the "Import: summaries at once" setting. */
  constructor(source: string | { directory: string; store: Store; saved: Saved }, private readonly compress: Compressor,
    private readonly warn: (s: string) => void = console.error,
    readonly budget = VIEW, private readonly jobs = 8, private readonly retryMs?: number, defer = 1, initializeLater = false) {
    this.chat = new Sawtooth(budget, budget / 2, part => this.node(part), i => this.unbuiltText(i), budget * Math.max(1, defer));
    this.compaction = new Sawtooth(budget / 4, budget / 8, part => this.node(part), i => this.unbuiltText(i));
    let saved: Saved;
    if (typeof source === 'string') { const store = new FileStore(source, warn); this.directory = source; this.store = store; this.tree = new ColdTreeMap(store); saved = store.load(HOT_TEXTS, HOT_TEXT_BYTES); }
    else { ({ directory: this.directory, store: this.store, saved } = source); this.tree = new ColdTreeMap(this.store); }
    this.cold = new ColdIndex(this.store);
    if (!initializeLater) runSync(this.initialize(saved));
  }
  private *initialize(saved: Saved): Generator<void, void> {
    const entries = saved.entries as Entry[];
    for (const value of entries) { if (!isEntry(value) && !isColdRecord(value)) throw new Error('Invalid/noncontiguous OptChat log; refusing to change it.'); yield; }
    yield* sortSteps(entries, (a, b) => a.i - b.i);
    for (let i = 0; i < entries.length; i++) { if (entries[i].i !== i) throw new Error('Invalid/noncontiguous OptChat log; refusing to change it.'); yield; }
    this.cold.reserve(entries.length);
    for (const value of entries) {
      if (isColdRecord(value)) { this.cold.set(value); this.root.push(new ColdEntry(value.i, this.cold)); }
      else {
        const textBytes = bytes(value.text);
        this.root.push({ ...value, size: textBytes + value.kind.length + 2 });
        this.hotBytes += textBytes;
      }
      yield;
    }
    entries.length = 0;
    yield* this.loadTree(saved.tree);
    saved.tree.length = 0;
    for (const node of this.tree.values()) { this.queueParent(node); yield; }
    for (let i = 0; i < this.root.length; i++) {
      if (!this.node({ l: 0, i })) {
        this.unbuilt.add(i);
        const entry = this.root[i];
        if (Object.getOwnPropertyDescriptor(entry, 'text')?.writable) this.unbuiltHotBytes += bytes(entry.text);
      }
      yield;
    }
    this.chillHot();

    const loaded = this.load(saved.view);
    for (const part of this.view) this.compaction.push(part);
    this.compaction.fit(loaded, true);
    for (let i = loaded; i < this.root.length; i++) { this.push(i); this.fit(i + 1); yield; }
    this.fit(); this.save();
    yield* this.chillTree();
    this.schedule();
  }
  /** Summaries outside the shown views are read back from disk when needed instead of held as text. */
  private *chillTree(): Generator<void, void> {
    if (!this.store.hasNode) return;
    const shown = new Set([...this.chat.parts, ...this.compaction.parts].map(key));
    for (const [id, node] of this.tree) {
      if (shown.has(id)) {
        if (node instanceof ColdSummary) this.tree.set(id, { l: node.l, i: node.i, text: node.text, size: node.size });
      } else if (Object.getOwnPropertyDescriptor(node, 'text')?.writable && this.store.hasNode(node.l, node.i)) {
        this.tree.set(id, new ColdSummary(node.l, node.i, node.size, this.store));
      }
      yield;
    }
    this.store.close?.();
  }
  private chillUnshownTree() {
    if (!this.store.hasNode || this.tree.warmSize <= this.chat.parts.length + this.compaction.parts.length + 64) return;
    const shown = new Set([...this.chat.parts, ...this.compaction.parts].map(key));
    for (const node of [...this.tree.warmValues()]) {
      const id = key(node);
      if (!shown.has(id) && Object.getOwnPropertyDescriptor(node, 'text')?.writable && this.store.hasNode(node.l, node.i)) {
        this.tree.set(id, new ColdSummary(node.l, node.i, node.size, this.store));
      }
    }
  }
  private *loadTree(records: unknown[]): Generator<void, void> {
    const revisions: (Summary | ColdSummaryRecord)[] = [], originals: (Summary | ColdSummaryRecord)[] = [], terminal: TerminalRecord[] = [];
    for (const value of records) {
      if (isSummary(value) || isColdSummary(value)) { if (value.revised) revisions.push(value); else originals.push(value); }
      else if (isTerminalRecord(value)) terminal.push(value);
      else this.warn('Skipped an invalid OptChat summary record.');
      yield;
    }
    yield* sortSteps(originals, (a, b) => a.l - b.l || a.i - b.i);
    yield* this.loadSummaries(originals);
    originals.length = 0;
    for (const value of revisions) {
      yield;
      if (!this.tree.has(key(value)) || (!isColdSummary(value) && !value.text.trim())) { this.warn('Skipped a revision of a missing OptChat summary.'); continue; }
      this.tree.set(key(value), isColdSummary(value) && this.store.hasNode?.(value.l, value.i)
        ? new ColdSummary(value.l, value.i, value.size, this.store)
        : { l: value.l, i: value.i, text: isColdSummary(value) ? this.store.nodeText!(value.l, value.i) : value.text, size: isColdSummary(value) ? value.size : lineBytes(value.text) });
    }
    yield* this.loadTerminalRecords(terminal);
  }
  private *loadSummaries(summaries: (Summary | ColdSummaryRecord)[]): Generator<void, void> {
    for (const value of summaries) {
      yield;
      const children = value.l === 0 || (this.tree.has(key({ l: value.l - 1, i: 2 * value.i })) && this.tree.has(key({ l: value.l - 1, i: 2 * value.i + 1 })));
      if (value.l < 0 || value.i < 0 || (!isColdSummary(value) && !value.text.trim()) || end(value) > this.root.length || !children || this.tree.has(key(value))) {
        this.warn('Skipped an incomplete or invalid OptChat summary record.');
        continue;
      }
      this.tree.set(key(value), isColdSummary(value) && this.store.hasNode?.(value.l, value.i)
        ? new ColdSummary(value.l, value.i, value.size, this.store)
        : { ...(value as Summary), size: isColdSummary(value) ? value.size : lineBytes((value as Summary).text) });
    }
  }
  private *loadTerminalRecords(records: TerminalRecord[]): Generator<void, void> {
    for (const value of records) {
      yield;
      const part = { l: value.l, i: value.i };
      const children = part.l === 0 || (this.node({ l: part.l - 1, i: 2 * part.i }) && this.node({ l: part.l - 1, i: 2 * part.i + 1 }));
      if (part.l < 0 || part.i < 0 || end(part) > this.root.length || !children) {
        this.warn('Skipped an invalid OptChat terminal record.');
        continue;
      }
      if (value.type === 'terminal') this.terminal.set(key(part), value.code);
      else this.terminal.delete(key(part));
    }
    for (const id of this.terminal.keys()) { if (this.tree.has(id)) this.terminal.delete(id); yield; }
    if (this.terminal.size) this.lastError = 'Summary blocked by policy refusal; explicit retry required.';
  }
  append(kind: Kind, text: string, date = new Date().toISOString(), receipt?: string, origin?: Origin) {
    if (this.stopped) throw new Error('Memory is closed.');
    if (this.failed) throw new Error(`Memory could not be saved: ${this.failed}`);
    const clean = kind === 'echo' ? scrubSecrets(text) : text;
    const textBytes = bytes(clean);
    const entry: Entry = { i: this.root.length, kind, text: clean, date, size: textBytes + kind.length + 2, ...(receipt ? { receipt } : {}), ...(origin ? { origin } : {}) };

    this.retryAt.clear();
    void this.enqueue(() => this.store.append(entry), error => {
      this.failed ??= error instanceof Error ? error.message : String(error);
      this.warn(`Memory could not be saved: ${this.failed}`);
    });
    this.root.push(entry); this.hotBytes += textBytes; this.unbuiltHotBytes += textBytes; this.push(entry.i); this.chillHot(); if (this.fit()) this.save(); this.schedule();
    return entry;
  }
  /** Drops a summarized message's text from RAM when the store can read it back: the entry keeps a `text` that reads it. */
  private chill(i: number) {
    const entry = this.root[i];
    if (!entry || !this.node({ l: 0, i }) || !Object.getOwnPropertyDescriptor(entry, 'text')?.writable) return false;
    if (!this.store.reader?.(i)) return false;
    this.hotBytes = Math.max(0, this.hotBytes - bytes(entry.text));
    this.cold.set(entry);
    this.root[i] = new ColdEntry(i, this.cold);
    return true;
  }
  private chillHot() {
    if (!this.store.reader) return;
    const countLimit = Math.max(0, this.root.length - HOT_TEXTS);
    let firstHot = -1;
    for (let i = this.hotCursor; i < this.root.length; i++) {
      const overCount = i < countLimit;
      const overBytes = this.hotBytes > HOT_TEXT_BYTES && this.hotBytes > this.unbuiltHotBytes;
      if (!overCount && !overBytes) break;
      const entry = this.root[i];
      if (!Object.getOwnPropertyDescriptor(entry, 'text')?.writable) continue;
      if (!this.chill(i) && firstHot < 0) firstHot = i;
    }
    if (firstHot >= 0) this.hotCursor = firstHot;
    else while (this.hotCursor < this.root.length && !Object.getOwnPropertyDescriptor(this.root[this.hotCursor], 'text')?.writable) this.hotCursor++;
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
  private unbuiltText(i: number) { return unbuiltHead(this.root[i].text); }
  private text(part: Part) { return this.node(part)?.text ?? (part.l === 0 ? this.unbuiltText(part.i) : UNBUILT); }
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
  /** Cache a displayed summary so repeated renders do not reread it from disk. */
  viewNode(part: Part) {
    const node = this.node(part);
    if (!(node instanceof ColdSummary)) return node;
    const warm = { l: node.l, i: node.i, size: node.size, text: node.text };
    this.tree.set(key(part), warm);
    return warm;
  }
  render() { return `${VIEW_OPEN}${this.view.map(p => `${start(p)}+${2 ** p.l}|${flat(this.viewNode(p)?.text ?? (p.l === 0 ? this.unbuiltText(p.i) : UNBUILT))}`).join('\n')}\n</chat>`; }
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

    const now = Date.now();
    const run = (part: Part) => {
      const id = key(part);
      if (this.busy.has(id) || this.terminal.has(id) || (this.retryAt.get(id) ?? 0) > now) return;

      const promise = this.build(part).catch(error => this.handleFailure(part, error))
        .finally(() => { this.busy.delete(id); this.schedule(); this.events.emit('change'); });
      this.busy.set(id, promise);
    };

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
  /** Rewrites, through the compactor, each shown line for which `stale` returns a note (what to drop); the new text is appended
   * as a revision record, so it wins on load too. Returns how many lines changed. Used once to clean closed conflicts. */
  async revise(stale: (text: string) => string | undefined, signal: AbortSignal = this.controller.signal) {
    let changed = 0;
    for (const part of [...this.view]) {
      const node = this.node(part), note = node && stale(node.text);

      if (!node || note === undefined || part.l === 0 && node.text === `${this.root[part.i].kind}: ${this.root[part.i].text}`) continue;
      let text = (await this.compress({ context: `${VIEW_OPEN}</chat>`, source: node.text, part, revise: note }, signal)).trim();
      if (text && part.l === 0) text = labeled(this.root[part.i].kind, text);
      if (!text || text === node.text || this.stopped) continue;
      const revised: Summary = { ...part, text, size: lineBytes(text), revised: true };
      const written = this.enqueue(() => this.store.appendNode(revised), error => { throw error; });
      if (written) await written;
      this.tree.set(key(part), { ...part, text, size: revised.size });
      this.chat.resized(part, revised.size - node.size); this.compaction.resized(part, revised.size - node.size);
      changed++;
    }
    return changed;
  }
  /** A call's summary waits for its result, while only calls and results follow it. */
  private awaitingResult(i: number) {
    if (this.root[i].kind !== 'tool' || this.resultOf(i) !== undefined) return false;
    for (let j = i + 1; j < this.root.length; j++) if (this.root[j].kind !== 'tool' && this.root[j].kind !== 'echo') return false;
    return true;
  }
  private hasOriginInRange(from: number, to: number) {
    for (let i = from; i < to && i < this.root.length; i++) {
      const entry = this.root[i];
      if (entry instanceof ColdEntry ? this.cold.hasOrigin(i) : !!entry.origin) return true;
    }
    return false;
  }
  private async build(part: Part) {
    const leaf = part.l === 0 ? this.root[part.i] : undefined;
    const leafText = leaf ? (leaf.kind === 'echo' ? scrubSecrets(leaf.text) : leaf.text) : '';
    const source = leaf ? `${leaf.kind}: ${leafText}`
      : [0, 1].map(offset => this.text({ l: part.l - 1, i: 2 * part.i + offset })).join('\n');
    const mergeSource = part.l > 0 ? [0, 1].map(offset => flat(this.text({ l: part.l - 1, i: 2 * part.i + offset }))).join('\n')
      : leaf?.kind === 'echo' ? cap(source) : source;
    const rawResult = leaf?.kind === 'tool' ? this.resultOf(part.i) : undefined;
    const result = rawResult === undefined ? undefined : scrubSecrets(rawResult);
    const call = part.l === 0 ? this.callOf(part.i) : undefined;
    let text = bytes(source) <= NODE ? source : (await this.compress({ context: this.compactionView(part), source: mergeSource, part,
      historical: this.hasOriginInRange(start(part), end(part)),
      ...(result === undefined ? {} : { result: cap(result, RESULT) }),
      ...(call ? { call: { i: call.i, text: cap(`tool: ${call.text}`, 4000) } } : {}) }, this.controller.signal)).trim();

    if (text && part.l === 0 && text !== source) text = labeled(this.root[part.i].kind, text);
    if (this.stopped) return;
    if (!text) throw new Error('Compactor returned an empty summary.');
    const node = { ...part, text, size: lineBytes(text) };

    const written = this.enqueue(() => this.store.appendNode(node), error => { throw error; });
    if (written) await written;
    this.tree.set(key(part), node); this.retryAt.delete(key(part)); this.merges.delete(key(part)); this.queueParent(part);
    if (!part.l) {
      const wasUnbuilt = this.unbuilt.delete(part.i); this.chat.built(part.i); this.compaction.built(part.i);
      const leafEntry = this.root[part.i];
      if (wasUnbuilt && Object.getOwnPropertyDescriptor(leafEntry, 'text')?.writable)
        this.unbuiltHotBytes = Math.max(0, this.unbuiltHotBytes - bytes(leafEntry.text));
      this.chillHot();
    }
    if (!this.retryAt.size && !this.terminal.size) this.lastError = undefined;
    if (this.fit()) this.save();
    this.chillUnshownTree();
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
  /** `graceMs` (turn only): past it, a turn stops waiting for summaries of single messages, which it shows as not summarized yet
   * (zoomable); a merged line still waits, since its placeholder would hide several. */
  async settle(signal?: AbortSignal, until: 'turn' | 'tree' | 'ahead' = 'turn', graceMs?: number): Promise<void> {
    let graceOver = false;
    const done = () => until === 'tree' ? this.ready && this.busy.size === 0 && this.tree.size === this.expectedNodes()
      : until === 'ahead' ? this.unbuilt.size + this.merges.size < this.jobs
      : this.ready || this.stalled || graceOver && this.view.every(p => p.l === 0 || this.node(p));
    const blockedError = () => new Error('Memory wait blocked by policy refusal; explicit retry required.');
    if (done()) return;
    if (this.stopped || signal?.aborted) throw new Error('Memory wait cancelled.');
    if (this.isWaitBlocked(until)) throw blockedError();
    const flush = until !== 'ahead';
    if (flush) { this.flushing++; this.schedule(); }
    await new Promise<void>((resolve, reject) => {
      const timer = until === 'turn' && graceMs !== undefined ? setTimeout(() => { graceOver = true; check(); }, graceMs) : undefined;
      const cleanup = () => { clearTimeout(timer); if (flush) this.flushing--; this.events.off('change', check); signal?.removeEventListener('abort', abort); };
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

      const from = /[\udc00-\udfff]/.test(text[offset ?? 0] ?? '') ? (offset ?? 0) - 1 : offset ?? 0;
      let to = Math.min(text.length, from + page);

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
  /** Original messages containing `text`, ignoring case, newest first, older than message `before`. Never summaries,
   * nor the logged zoom/search calls and results, which only copy memory. Tree changes do not affect original-message hits. */
  search(text: string, before = this.root.length) {
    const needle = text.toLowerCase(), limit = Math.min(before, this.root.length);
    const hits = this.hitIndexes(needle, limit), page: Entry[] = [];
    for (let k = hits.length - 1; k >= 0; k--) if (hits[k] < limit) page.push(this.root[hits[k]]);
    return page;
  }
  /** Ascending indexes of the messages containing `needle`. History is append-only, so a retained query is extended over
   * the messages added since it last ran instead of being rescanned; a query too broad to retain scans only below `limit`. */
  private hitIndexes(needle: string, limit: number): readonly number[] {
    const retained = needle.length > 0 && needle.length <= SEARCH_CACHE_QUERY_CHARS;
    const index = (retained && this.searchCache.get(needle)) || { scanned: 0, hits: [] as number[] };
    this.extendHits(needle, index, retained ? this.root.length : limit);
    if (retained) this.retainHits(needle, index);
    return index.hits;
  }
  private extendHits(needle: string, index: HitIndex, end: number) {
    for (let i = index.scanned; i < end; i++) {
      this.scans++;
      const entry = this.root[i], text = entry.text;
      if ((entry.kind === 'tool' || entry.kind === 'echo') && /^(zoom|search)[ :]/.test(text)) continue;
      if (text.toLowerCase().includes(needle)) index.hits.push(i);
    }
    index.scanned = Math.max(index.scanned, end);
  }
  /** Keeps the query most recently used, evicting the least recent queries past the query and total-index budgets. */
  private retainHits(needle: string, index: HitIndex) {
    this.searchCache.delete(needle);
    if (index.hits.length > SEARCH_CACHE_HITS) return;
    this.searchCache.set(needle, index);
    const retainedHits = () => [...this.searchCache.values()].reduce((sum, held) => sum + held.hits.length, 0);
    while (this.searchCache.size > SEARCH_CACHE_QUERIES || retainedHits() > SEARCH_CACHE_HITS) {
      const oldest = this.searchCache.keys().next().value;
      if (oldest === undefined || oldest === needle) break;
      this.searchCache.delete(oldest);
    }
  }
  date(id: number) {
    if (!Number.isSafeInteger(id) || !this.root[id]) throw new Error(`No message ${id}. ${messageScope(this.root.length)}${this.root.length ? '.' : ''}`);
    return new Date(this.root[id].date).toString();
  }
  async close(reason: 'reload' | 'shutdown' | 'import' | 'memory_close' = 'memory_close') {
    this.stopped = true; this.controller.abort(new DOMException(reason, 'AbortError')); clearTimeout(this.retryTimer);
    this.events.emit('change'); await Promise.allSettled(this.busy.values()); await this.writing;
    this.searchCache.clear(); this.store.close?.();
  }
}
