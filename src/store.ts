import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { open, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { runSync } from './sliced.ts';
import { basename, dirname, join, resolve } from 'node:path';
import type { Entry, Summary } from './memory.ts';
import { scrubSecrets } from './secret-scrub.ts';

/** The image types memory keeps, and the file extension each is saved under. */
export const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as const;
export type Mime = keyof typeof EXTENSIONS;
export const isMime = (mime: string): mime is Mime => Object.hasOwn(EXTENSIONS, mime);
const MIMES = new Map<string, Mime>((Object.keys(EXTENSIONS) as Mime[]).map(mime => [EXTENSIONS[mime], mime]));

/** What a store gives back when a memory opens. Memory validates every record itself; `view` is the JSON `saveView` was last given. */
export interface Saved { entries: unknown[]; tree: unknown[]; view?: string }
/** A safe, append-only scheduler state: only the refusal code and summary coordinates are persisted, never error text. */
export interface TerminalRecord { type: 'terminal' | 'retry'; l: number; i: number; code: 'OPTCHAT_POLICY_REFUSAL' }

type Write = Promise<void> | undefined;
type Maybe<T> = T | Promise<T>;

/** Cross-machine exclusivity. Implement it only if you want it: without it OptChat keeps its machine-local lock (a socket in the
 * profile, or a named pipe on Windows), so two Pis on one machine still can't share a profile. */
export interface Lease {
  /** Takes the profile for `holder` (who and where, shown to anyone refused), or returns the current holder.
   * A lease not renewed for about 30 seconds may be taken by someone else. */
  lease(profile: string, holder: string): Promise<string | undefined>;
  /** Renews the lease. OptChat calls it every 10 seconds while it holds the profile and only warns when it fails, so fencing is
   * the store's job: once its lease may have lapsed, it must refuse writes (for example with a fencing token checked on each one),
   * since a paused process cannot be trusted to stop itself in time. */
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

/** Where one memory keeps what travels between machines: its message log, summary nodes, saved view and images. Everything else
 * in a profile (runs, recovery journals, the active-memory pointer and imports, usage, settings, AGENTS.md) stays on the machine.
 * Memory loads once when it opens, then works in RAM and issues every write in order. */
export interface Store {
  /** With `hot` and `hotBytes`, a store that can read texts back (`reader`) may return older summarized messages without text, with their `size`. */
  load(hot?: number, hotBytes?: number): Maybe<Saved>;
  /** Appends a message. Throws, writing nothing, if someone else appended since this store loaded. */
  append(entry: Entry): Write;
  /** Appends a summary node. */
  appendNode(node: Summary): Write;
  /** Persists a policy-refusal block or explicit retry when supported by the store. */
  appendTerminal?(record: TerminalRecord): Write;
  /** Replaces the saved view. */
  saveView(view: string): Write;
  putImage(name: string, mimeType: Mime, data: Uint8Array): Write;
  image(name: string): Maybe<{ mimeType: Mime; data: Uint8Array } | undefined>;
  /** Reads message `i`'s text back from the log, so Memory can drop old texts from RAM. Undefined when the store cannot. */
  reader?(i: number): (() => string) | undefined;
  /** Reads message `i`'s full JSON record back from the log when available. */
  readRecord?(i: number): Record<string, unknown> | undefined;
  /** Whether summary node (`l`, `i`) can be read back from the tree files, so Memory can drop old summaries from RAM. */
  hasNode?(l: number, i: number): boolean;
  /** Reads summary node (`l`, `i`) back from the tree files. */
  nodeText?(l: number, i: number): string;
  /** How many messages' log positions the store keeps in RAM, for diagnostics. */
  lineIndexSize?(): number;
  close?(): void;
  lock?: Lease;
}

/** The one place a profile's store is chosen. A `store` setting will plug in here; until then every profile keeps its memory in files. */
export const storeFor = (directory: string, warn: (s: string) => void = console.error): Store => new FileStore(directory, warn);

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/** A small JSON state file, or `fallback` when it is missing or unreadable (state that a later round rebuilds). */
export function readJsonOr<T>(file: string, fallback: T): T {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : fallback; } catch { return fallback; }
}
/** `$env` when set, else `~/<home...>`: a directory chosen by the environment, so tests and other setups can move it. */
export const envDir = (env: string, ...home: string[]) => process.env[env] ?? join(homedir(), ...home);

/** The records of a JSON-lines log that `keep` accepts; a torn or unreadable line is skipped, a missing file is empty. */
export function readJsonl<T>(file: string, keep: (value: T) => boolean): T[] {
  let raw = '';
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  return raw.split('\n').flatMap(line => { try { const value = JSON.parse(line) as T; return keep(value) ? [value] : []; } catch { return []; } });
}
/** Appends one record; once the log passes `maxBytes` it is rewritten with only the records `keep` accepts. */
export function appendJsonl<T>(file: string, value: T, maxBytes: number, keep: (value: T) => boolean): void {
  appendFileSync(file, `${JSON.stringify(value)}\n`);
  if (statSync(file).size > maxBytes) atomicWrite(file, readJsonl(file, keep).map(v => JSON.stringify(v)).join('\n') + '\n');
}
/** A timed log: past `maxBytes` it keeps only the records younger than `keepMs` at the time of the newest one. */
export const appendRecent = <T extends { at: number }>(file: string, value: T, maxBytes: number, keepMs: number) =>
  appendJsonl<T>(file, value, maxBytes, e => e.at >= value.at - keepMs);

const WINDOWS_LOCKS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_MS = 2_000;
// external: Windows file sharing can transiently block rename with Defender or an indexer.
function renameRetryingWindowsLocks(temporary: string, file: string) {
  const started = Date.now();
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try { renameSync(temporary, file); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      const occupiedDir = code === 'EPERM' && (() => { try { return lstatSync(file).isDirectory(); } catch { return false; } })();
      if (occupiedDir || !WINDOWS_LOCKS.has(code) || Date.now() - started >= RENAME_RETRY_MS) {
        try { rmSync(temporary, { force: true }); } catch {   }
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}
export function atomicWrite(file: string, text: string | Uint8Array) {
  mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  // external: Windows cannot fsync read-only handles or open a directory for fsync.
  const fd = openSync(temporary, 'w+', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  if (process.platform !== 'win32') renameSync(temporary, file);
  else { renameRetryingWindowsLocks(temporary, file); return; }
  const parent = openSync(resolve(file, '..'), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
const otherWriter = (file: string) => new Error(`Another process wrote ${file}. Close every other Pi on this profile and restart Pi; nothing was written.`);


function completeLength(fd: number, length: number) {
  const block = Buffer.alloc(4096);
  for (let end = length; end > 0;) {
    const start = Math.max(0, end - block.length), count = readSync(fd, block, 0, end - start, start);
    const newline = block.lastIndexOf(0x0a, count - 1);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}
/** Appends one newline-committed JSON record. An unterminated tail is an interrupted write, not a record; discard it before
 * another append so a parseable payload without its commit delimiter cannot become visible after restart. */
export function appendJson(file: string, value: unknown, size?: number) {
  const fd = openSync(file, 'a+', 0o600);
  try {
    let length = fstatSync(fd).size;
    if (size !== undefined && length !== size) throw otherWriter(file);
    if (length > 0) {
      const last = Buffer.alloc(1);
      if (readSync(fd, last, 0, 1, length - 1) === 1 && last[0] !== 0x0a) {
        length = completeLength(fd, length);
        // external: Windows cannot truncate through an append handle.
        truncateSync(file, length);
      }
    }
    const data = Buffer.from(JSON.stringify(value) + '\n');


    try { if (writeSync(fd, data) !== data.length) throw new Error(`Incomplete write: ${file}`); }
    catch (error) { try { truncateSync(file, length); } catch {} throw error; }
    fsyncSync(fd);
    return fstatSync(fd).size;
  } finally { closeSync(fd); }
}

type Located = (value: unknown, file: string, offset: number, length: number) => void;

type DayRow = [offset: number, length: number, value: unknown, textless: 0 | 1];

function textless(value: unknown) {
  const record = value as { i?: unknown; kind?: unknown; text?: unknown } | null;
  if (!record || typeof record.kind !== 'string' || typeof record.text !== 'string' || !Number.isSafeInteger(record.i)) return undefined;
  const { text, ...rest } = record;
  return { ...rest, size: Buffer.byteLength(`${record.kind}: ${text}`) };
}
/** A summary record without its text and with its `size`, or undefined if not a non-empty summary. */
export interface ColdSummaryRecord { l: number; i: number; size: number; revised?: true; text?: never }
export function coldSummary(value: unknown): ColdSummaryRecord | undefined {
  const record = value as { l?: unknown; i?: unknown; text?: unknown; revised?: unknown } | null;
  if (!record || !Number.isSafeInteger(record.l) || !Number.isSafeInteger(record.i) || typeof record.text !== 'string') return undefined;
  if (!record.text.trim()) return undefined;
  const size = Buffer.byteLength(record.text.replace(/[\r\n]+/g, ' '), 'utf8');
  return { l: record.l as number, i: record.i as number, size, ...(record.revised === true ? { revised: true as const } : {}) };
}
const logNames = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort() : [];
function records(dir: string, warn: (s: string) => void, located: Located) {
  for (const name of logNames(dir)) fileRecords(join(dir, name), warn, located);
}
function fileRecords(file: string, warn: (s: string) => void, located: Located) {
  runSync(parseRecords(readFileSync(file), file, warn, located));
}
async function scanJsonl(file: string, warn: (s: string) => void, located: Located) {
  const CHUNK = 256 * 1024;
  const buf = Buffer.allocUnsafe(CHUNK);
  let carry = Buffer.alloc(0);
  let baseOffset = 0, index = 0;
  let started = performance.now(), steps = 0;
  const fh = await open(file, 'r');
  try {
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      const view = buf.subarray(0, bytesRead);
      const data = carry.length ? Buffer.concat([carry, view]) : view;
      let from = 0;
      for (let nl = data.indexOf(0x0a); nl >= 0; from = nl + 1, nl = data.indexOf(0x0a, from)) {
        index++;
        const line = data.toString('utf8', from, nl);
        if (line.trim()) {
          let value: unknown;
          try { value = JSON.parse(line); }
          catch { warn(`Skipped damaged JSON at ${file}:${index}`); continue; }
          located(value, file, baseOffset + from, nl - from);
        }
        if (++steps % 256 === 0 && performance.now() - started >= 15) {
          await yieldLoop();
          started = performance.now();
        }
      }
      carry = from < data.length ? Buffer.from(data.subarray(from)) : Buffer.alloc(0);
      baseOffset += data.length - carry.length;
      if (performance.now() - started >= 15) {
        await yieldLoop();
        started = performance.now();
      }
    }
    if (carry.toString('utf8').trim()) warn(`Skipped damaged JSON at ${file}:${index + 1}`);
  } finally {
    await fh.close();
  }
}
function* parseRecords(data: Buffer, file: string, warn: (s: string) => void, located: Located): Generator<void, void> {
  let from = 0, index = 0;

  for (let newline = data.indexOf(0x0a); newline >= 0; from = newline + 1, newline = data.indexOf(0x0a, from)) {
    index++;
    const line = data.toString('utf8', from, newline);
    if (line.trim()) {
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { warn(`Skipped damaged JSON at ${file}:${index}`); yield; continue; }
      located(value, file, from, newline - from);
    }
    yield;
  }
  if (data.toString('utf8', from).trim()) warn(`Skipped damaged JSON at ${file}:${index + 1}`);
}

function lineText(data: Buffer, offset: number, length: number, i: number, file: string) {
  const moved = () => new Error(`Message ${i} is no longer where it was in ${file}; restart Pi to reload the memory.`);
  let record: { i?: unknown; text?: unknown } | null;
  try { record = JSON.parse(data.toString('utf8', offset, offset + length)); } catch { throw moved(); }
  if (record?.i !== i || typeof record.text !== 'string') throw moved();
  return record.text;
}

const READ_CACHE_MS = 1000;

const MAX_PACKED_INDEX = 10_000_000;
const MAX_PACKED_LEVEL = 32;
function grow<T extends Float64Array | Uint32Array | Uint16Array>(arr: T, minLength: number, Ctor: { new(n: number): T }): T {
  const next = new Ctor(Math.max(minLength, arr.length ? arr.length * 2 : 1024));
  next.set(arr);
  return next;
}

/** Memory as files in one directory: `main/` and `tree/` hold dated JSONL, each line fsynced as it is appended; `view.json` and
 * `images/<hash>.<ext>` are replaced atomically. Every write is done when it returns. */
export class FileStore implements Store {
  /** Each log file's size as this store last left it, so a write by another process is refused instead of interleaved. */
  private readonly lastSeenBytes = new Map<string, number>();
  /** Where each message's line is, by message index, packed in typed arrays (~14 bytes/msg instead of JS objects + Map). */
  private readonly lineFiles: string[] = [];
  private lineSlots = new Uint16Array(0);
  private lineOffsets = new Float64Array(0);
  private lineLengths = new Uint32Array(0);
  private lineCount = 0;
  private extraLines?: Map<number, { file: string; offset: number; length: number }>;
  /** Where each summary node's latest line starts, by level and index (slot * 2^40 + offset + 1, 0 = absent). */
  private readonly nodeLevels: Float64Array[] = [];
  private extraNodes?: Map<number, number>;
  private readonly nodeFiles: string[] = [];
  private cached?: { file: string; data: Buffer; timer: ReturnType<typeof setTimeout> };
  constructor(readonly directory: string, private readonly warn: (s: string) => void = console.error) {}
  private clearIndex() {
    this.lineFiles.length = 0; this.lineSlots = new Uint16Array(0); this.lineOffsets = new Float64Array(0);
    this.lineLengths = new Uint32Array(0); this.lineCount = 0; this.extraLines = undefined;
    this.nodeLevels.length = 0; this.extraNodes = undefined; this.nodeFiles.length = 0;
  }
  private fileSlot(files: string[], file: string) {
    const slot = files.lastIndexOf(file);
    return slot >= 0 ? slot : files.push(file) - 1;
  }
  private setLine(i: number, file: string, offset: number, length: number) {
    if (i < 0 || i >= MAX_PACKED_INDEX) {
      const extra = (this.extraLines ??= new Map());
      if (!extra.has(i)) this.lineCount++;
      extra.set(i, { file, offset, length });
      return;
    }
    if (i >= this.lineOffsets.length) {
      this.lineSlots = grow(this.lineSlots, i + 1, Uint16Array);
      this.lineOffsets = grow(this.lineOffsets, i + 1, Float64Array);
      this.lineLengths = grow(this.lineLengths, i + 1, Uint32Array);
    }
    if (this.lineOffsets[i] === 0) this.lineCount++;
    this.lineSlots[i] = this.fileSlot(this.lineFiles, file);
    this.lineOffsets[i] = offset + 1;
    this.lineLengths[i] = length;
  }
  private getLine(i: number) {
    if (i >= 0 && i < this.lineOffsets.length && this.lineOffsets[i] !== 0) {
      return { file: this.lineFiles[this.lineSlots[i]], offset: this.lineOffsets[i] - 1, length: this.lineLengths[i] };
    }
    return this.extraLines?.get(i);
  }
  private setNode(l: number, i: number, file: string, offset: number) {
    const at = this.fileSlot(this.nodeFiles, file) * 2 ** 40 + offset;
    if (l < 0 || l >= MAX_PACKED_LEVEL || i < 0 || i >= MAX_PACKED_INDEX) {
      (this.extraNodes ??= new Map()).set(l * 2 ** 40 + i, at);
      return;
    }
    let level = this.nodeLevels[l];
    if (!level || i >= level.length) level = this.nodeLevels[l] = grow(level ?? new Float64Array(0), i + 1, Float64Array);
    level[i] = at + 1;
  }
  private getNode(l: number, i: number) {
    if (l >= 0 && l < this.nodeLevels.length && i >= 0 && i < this.nodeLevels[l].length) {
      const v = this.nodeLevels[l][i];
      return v === 0 ? undefined : v - 1;
    }
    return this.extraNodes?.get(l * 2 ** 40 + i);
  }
  private trackTailHot(entries: unknown[], slim: Set<number>, value: unknown, hot: number, hotBytes: number, state: { bytes: number; cursor: number }) {
    const text = (value as { text?: unknown } | null)?.text;
    if (typeof text === 'string') state.bytes += Buffer.byteLength(text);
    const old = entries.push(value) - 1 - hot;
    if (old >= 0 && !slim.has(old)) {
      const before = (entries[old] as { text?: unknown } | null)?.text;
      const chilled = this.cold(entries[old]);
      if (chilled !== entries[old] && typeof before === 'string') state.bytes = Math.max(0, state.bytes - Buffer.byteLength(before));
      entries[old] = chilled;
      if (old >= state.cursor) state.cursor = old + 1;
    }
    while (state.bytes > hotBytes && state.cursor < entries.length) {
      const candidate = entries[state.cursor], raw = (candidate as { text?: unknown } | null)?.text;
      const chilled = this.cold(candidate);
      if (chilled !== candidate && typeof raw === 'string') {
        state.bytes = Math.max(0, state.bytes - Buffer.byteLength(raw));
        entries[state.cursor] = chilled;
      }
      state.cursor++;
    }
  }
  private hydrateSlim(entries: unknown[], slim: Set<number>, hot: number, hotBytes: number, state: { bytes: number }) {
    const indexes = [...slim];
    let budgetFull = false;
    for (let idx = indexes.length - 1; idx >= 0; idx--) {
      const k = indexes[idx], value = entries[k] as { i: number; kind?: string; size?: number }, line = this.getLine(value.i);
      if (!line) continue;
      const unbuilt = !this.hasNode(0, value.i);
      const estimated = typeof value.size === 'number' && typeof value.kind === 'string' ? Math.max(0, value.size - value.kind.length - 2) : 0;
      const fitsBudget = !budgetFull && k >= entries.length - hot && state.bytes + estimated <= hotBytes;
      if (!unbuilt && !fitsBudget) {
        if (k >= entries.length - hot && state.bytes + estimated > hotBytes) budgetFull = true;
        continue;
      }
      const hydrated = JSON.parse(this.read(line.file).toString('utf8', line.offset, line.offset + line.length)) as { text?: unknown };
      entries[k] = hydrated;
      if (typeof hydrated.text === 'string') state.bytes += Buffer.byteLength(hydrated.text);
    }
  }
  /** Every record as saved, except that with `hot` set only the newest `hot` messages keep their text: an older one whose level-0
   * summary exists comes back as `{ ...fields, size }` without it, read later through `reader`. Parsing a long log into texts first
   * and dropping them after held them all at once (~280 MB of log: ~1 GB of RSS and seconds of frozen loop on each reload). */
  load(hot = Infinity, hotBytes = Infinity): Saved {
    for (const sub of ['main', 'tree']) mkdirSync(join(this.directory, sub), { recursive: true, mode: 0o700 });
    this.clearIndex();

    const tree: unknown[] = [];
    records(join(this.directory, 'tree'), this.warn, (value, file, offset, length) => {
      const { l, i, text } = (value ?? {}) as { l?: unknown; i?: unknown; text?: unknown };
      if (Number.isSafeInteger(l) && Number.isSafeInteger(i) && typeof text === 'string') this.setNode(l as number, i as number, file, offset);
      tree.push(hot < Infinity ? (coldSummary(value) ?? value) : value);
    });
    const main = join(this.directory, 'main'), entries: unknown[] = [], names = logNames(main);


    const slim = new Set<number>();
    for (const file of names.slice(0, -1).map(name => join(main, name))) for (const [offset, length, value, textlessRow] of this.dayIndex(file)) {
      const i = (value as { i?: unknown } | null)?.i;
      if (Number.isSafeInteger(i)) this.setLine(i as number, file, offset, length);
      if (textlessRow) slim.add(entries.length);
      entries.push(value);
    }
    const tailHot = { bytes: 0, cursor: entries.length };
    if (names.length) fileRecords(join(main, names[names.length - 1]), this.warn, (value, file, offset, length) => {
      const i = (value as { i?: unknown } | null)?.i;
      if (Number.isSafeInteger(i)) this.setLine(i as number, file, offset, length);
      this.trackTailHot(entries, slim, value, hot, hotBytes, tailHot);
    });
    this.hydrateSlim(entries, slim, hot, hotBytes, tailHot);
    this.drop();
    for (const name of readdirSync(main).filter(n => n.endsWith('.jsonl'))) this.lastSeenBytes.set(join(main, name), statSync(join(main, name)).size);
    const view = join(this.directory, 'view.json');

    let saved: string | undefined;
    if (existsSync(view)) try { saved = readFileSync(view, 'utf8'); } catch { saved = ''; }
    return { entries, tree, view: saved };
  }
  /** Load without holding the event loop while parsing history. Logs remain authoritative, including damaged tails. */
  async loadAsync(hot = Infinity, hotBytes = Infinity): Promise<Saved> {
    for (const sub of ['main', 'tree']) mkdirSync(join(this.directory, sub), { recursive: true, mode: 0o700 });
    this.clearIndex();
    const tree: unknown[] = [], entries: unknown[] = [];
    const observed = new Map<string, { size: number; mtimeMs: number }>();
    const scan = async (file: string, accept: Located) => {
      const stat = statSync(file);
      observed.set(file, { size: stat.size, mtimeMs: stat.mtimeMs });
      await scanJsonl(file, this.warn, accept);
    };
    const treeDir = join(this.directory, 'tree'), treeNames = logNames(treeDir);
    for (const name of treeNames) await scan(join(treeDir, name), (value, file, offset) => {
      const { l, i, text } = (value ?? {}) as { l?: unknown; i?: unknown; text?: unknown };
      if (Number.isSafeInteger(l) && Number.isSafeInteger(i) && typeof text === 'string') this.setNode(l as number, i as number, file, offset);
      tree.push(hot < Infinity ? (coldSummary(value) ?? value) : value);
    });
    const main = join(this.directory, 'main'), mainNames = logNames(main);
    const slim = new Set<number>();
    const pastNames = hot < Infinity ? mainNames.slice(0, -1) : [];
    for (const name of pastNames) {
      const file = join(main, name);
      const stat = statSync(file);
      observed.set(file, { size: stat.size, mtimeMs: stat.mtimeMs });
      const rows = await this.dayIndexAsync(file, stat);
      let started = performance.now(), steps = 0;
      for (const [offset, length, value, textlessRow] of rows) {
        const i = (value as { i?: unknown } | null)?.i;
        if (Number.isSafeInteger(i)) this.setLine(i as number, file, offset, length);
        if (textlessRow) slim.add(entries.length);
        entries.push(value);
        if (++steps % 512 === 0 && performance.now() - started >= 15) { await yieldLoop(); started = performance.now(); }
      }
    }
    const tailNames = hot < Infinity ? mainNames.slice(-1) : mainNames;
    const tailHot = { bytes: 0, cursor: entries.length };
    for (const name of tailNames) {
      const file = join(main, name);
      await scan(file, (value, _file, offset, length) => {
        const i = (value as { i?: unknown } | null)?.i;
        if (Number.isSafeInteger(i)) this.setLine(i as number, file, offset, length);
        this.trackTailHot(entries, slim, value, hot, hotBytes, tailHot);
      });
    }
    this.hydrateSlim(entries, slim, hot, hotBytes, tailHot);
    this.drop();
    const view = join(this.directory, 'view.json');
    let saved: string | undefined;
    if (existsSync(view)) try { saved = await readFile(view, 'utf8'); } catch { saved = ''; }

    for (const [dir, names] of [[treeDir, treeNames], [main, mainNames]] as const) {
      const now = logNames(dir);
      if (now.length !== names.length || now.some((name, i) => name !== names[i])) throw otherWriter(dir);
    }
    for (const [file, before] of observed) {
      const after = statSync(file);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw otherWriter(file);
      if (dirname(file) === main) this.lastSeenBytes.set(file, before.size);
    }
    return { entries, tree, view: saved };
  }
  private async dayIndexAsync(file: string, stat: { size: number; mtimeMs: number }): Promise<DayRow[]> {
    const index = join(this.directory, 'load-index', `${basename(file)}.json`);
    try {
      const saved = JSON.parse(await readFile(index, 'utf8')) as { version?: unknown; size?: unknown; mtimeMs?: unknown; rows?: unknown };
      if (saved.version === 1 && saved.size === stat.size && saved.mtimeMs === stat.mtimeMs && Array.isArray(saved.rows)) return saved.rows as DayRow[];
    } catch {}
    const rows: DayRow[] = [];
    let damaged = false;
    await scanJsonl(file, msg => { damaged = true; this.warn(msg); }, (value, _file, offset, length) => {
      const slim = textless(value);
      rows.push(slim ? [offset, length, slim, 1] : [offset, length, value, 0]);
    });
    if (!damaged) {
      try { mkdirSync(dirname(index), { recursive: true }); atomicWrite(index, JSON.stringify({ version: 1, size: stat.size, mtimeMs: stat.mtimeMs, rows })); }
      catch (error) { this.warn(`OptChat could not save the load index ${index}: ${(error as Error).message}`); }
    }
    return rows;
  }
  /** A summarized message without its text, with the `size` Memory gives it (the bytes of `kind: text`); anything else as is. */
  private cold(value: unknown) {
    const record = value as { i?: unknown } | null;
    return Number.isSafeInteger(record?.i) && this.hasNode(0, record!.i as number) ? textless(value) ?? value : value;
  }
  /** A past day's records, text dropped, with where each line lies: from its index when the day is unchanged since it was built. */
  private dayIndex(file: string): DayRow[] {
    const stat = statSync(file), index = join(this.directory, 'load-index', `${basename(file)}.json`);
    try {
      const saved = JSON.parse(readFileSync(index, 'utf8')) as { version?: unknown; size?: unknown; mtimeMs?: unknown; rows?: unknown };
      if (saved.version === 1 && saved.size === stat.size && saved.mtimeMs === stat.mtimeMs && Array.isArray(saved.rows)) return saved.rows as DayRow[];
    } catch {}
    const rows: DayRow[] = [];
    let damaged = false;
    fileRecords(file, msg => { damaged = true; this.warn(msg); }, (value, _file, offset, length) => {
      const slim = textless(value);
      rows.push(slim ? [offset, length, slim, 1] : [offset, length, value, 0]);
    });
    if (!damaged) {
      try { mkdirSync(dirname(index), { recursive: true }); atomicWrite(index, JSON.stringify({ version: 1, size: stat.size, mtimeMs: stat.mtimeMs, rows })); }
      catch (error) { this.warn(`OptChat could not save the load index ${index}: ${(error as Error).message}`); }
    }
    return rows;
  }
  append(entry: Entry): undefined {
    const file = join(this.directory, 'main', `${localDay()}.jsonl`);
    if (!this.lastSeenBytes.has(file)) this.checkLog(file);
    const clean = entry.kind === 'echo' ? scrubSecrets(entry.text) : entry.text;
    const record = clean === entry.text ? entry : { ...entry, text: clean, size: Buffer.byteLength(`${entry.kind}: ${clean}`, 'utf8') };
    const length = Buffer.byteLength(JSON.stringify(record)), size = appendJson(file, record, this.lastSeenBytes.get(file) ?? 0);
    this.lastSeenBytes.set(file, size);
    this.setLine(record.i, file, size - length - 1, length);
    if (this.cached?.file === file) this.drop();
  }
  lineIndexSize() { return this.lineCount; }
  reader(i: number) {
    const line = this.getLine(i);
    return line && (() => lineText(this.readAt(line.file, line.offset, line.length), 0, line.length, i, line.file));
  }
  readRecord(i: number): Record<string, unknown> | undefined {
    const line = this.getLine(i);
    if (!line) return undefined;
    try { return JSON.parse(this.readAt(line.file, line.offset, line.length).toString('utf8')) as Record<string, unknown>; }
    catch { return undefined; }
  }
  hasNode(l: number, i: number) { return this.getNode(l, i) !== undefined; }
  nodeText(l: number, i: number) {
    const at = this.getNode(l, i), file = this.nodeFiles[Math.floor((at ?? 0) / 2 ** 40)];
    let record: { l?: unknown; i?: unknown; text?: unknown } | null = null;
    if (at !== undefined) try {
      record = JSON.parse(this.readLineAt(file, at % 2 ** 40));
    } catch { record = null; }
    if (record?.l !== l || record.i !== i || typeof record.text !== 'string') throw new Error(`Summary ${l}:${i} is no longer where it was${file ? ` in ${file}` : ''}; restart Pi to reload the memory.`);
    return record.text;
  }
  private read(file: string) {
    if (this.cached?.file === file) { this.cached.timer.refresh(); return this.cached.data; }
    this.drop();
    const data = readFileSync(file), timer = setTimeout(() => this.drop(), READ_CACHE_MS);
    timer.unref();
    this.readBytes += data.length;
    this.cached = { file, data, timer };
    return data;
  }
  private drop() { if (this.cached) clearTimeout(this.cached.timer); this.cached = undefined; }
  /** Bytes this store read from its logs. A status render touches lines in many days, so a single lookup reads its own line,
   * never the whole day file (whole-file reads of the tree days cost ~40 MB per render). */
  readBytes = 0;
  private readAt(file: string, offset: number, length: number) {
    if (this.cached?.file === file) return this.cached.data.subarray(offset, offset + length);
    const fd = openSync(file, 'r');
    try {
      const data = Buffer.alloc(length), n = readSync(fd, data, 0, length, offset);
      this.readBytes += n;
      return data.subarray(0, n);
    } finally { closeSync(fd); }
  }
  /** The line that starts at `offset`, read in growing chunks until its newline or the end of the file. */
  private readLineAt(file: string, offset: number) {
    if (this.cached?.file === file) { const data = this.cached.data, end = data.indexOf(0x0a, offset); return data.toString('utf8', offset, end < 0 ? data.length : end); }
    const fd = openSync(file, 'r');
    try {
      let data = Buffer.alloc(0);
      for (let chunk = 4096; ; chunk *= 2) {
        const next = Buffer.alloc(chunk), n = readSync(fd, next, 0, chunk, offset + data.length);
        this.readBytes += n;
        const nl = next.subarray(0, n).indexOf(0x0a);
        if (nl >= 0) return Buffer.concat([data, next.subarray(0, nl)]).toString('utf8');
        data = Buffer.concat([data, next.subarray(0, n)]);
        if (n < chunk) return data.toString('utf8');
      }
    } finally { closeSync(fd); }
  }
  close() { this.drop(); }
  private checkLog(next: string) {
    const main = dirname(next), names = readdirSync(main).filter(n => n.endsWith('.jsonl'));
    if (names.length !== this.lastSeenBytes.size || names.some(n => statSync(join(main, n)).size !== this.lastSeenBytes.get(join(main, n)))) throw otherWriter(next);
  }
  appendNode(node: Summary | TerminalRecord): undefined {
    const file = join(this.directory, 'tree', `${localDay()}.jsonl`);
    const length = Buffer.byteLength(JSON.stringify(node));
    const size = appendJson(file, node);
    if ('text' in node && Number.isSafeInteger(node.l) && Number.isSafeInteger(node.i)) {
      this.setNode(node.l, node.i, file, size - length - 1);
    }
    if (this.cached?.file === file) this.drop();
  }
  appendTerminal(record: TerminalRecord): undefined { this.appendNode(record); }
  saveView(view: string): undefined { atomicWrite(join(this.directory, 'view.json'), view); }
  putImage(name: string, mimeType: Mime, data: Uint8Array): undefined { atomicWrite(join(this.directory, 'images', `${name}.${EXTENSIONS[mimeType]}`), data); }
  image(name: string) {
    let file: string | undefined;
    try { file = readdirSync(join(this.directory, 'images')).find(f => f.startsWith(`${name}.`) && MIMES.has(f.slice(name.length + 1))); } catch { return undefined; }
    const mimeType = file && MIMES.get(file.slice(name.length + 1));
    return file && mimeType ? { mimeType, data: readFileSync(join(this.directory, 'images', file)) } : undefined;
  }
}
