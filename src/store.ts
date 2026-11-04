import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Entry, Summary } from './memory.ts';

/** The image types memory keeps, and the file extension each is saved under. */
export const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as const;
export type Mime = keyof typeof EXTENSIONS;
export const isMime = (mime: string): mime is Mime => Object.hasOwn(EXTENSIONS, mime);
const MIMES = new Map<string, Mime>((Object.keys(EXTENSIONS) as Mime[]).map(mime => [EXTENSIONS[mime], mime]));

/** What a store gives back when a memory opens. Memory validates every record itself; `view` is the JSON `saveView` was last given. */
export interface Saved { entries: unknown[]; tree: unknown[]; view?: string }
/** A safe, append-only scheduler state: only the refusal code and summary coordinates are persisted, never error text. */
export interface TerminalRecord { type: 'terminal' | 'retry'; l: number; i: number; code: 'OPTCHAT_POLICY_REFUSAL' }
/** A write is done when it returns: a store that writes behind returns a promise instead, which Memory awaits in order. */
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
  load(): Maybe<Saved>;
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

export function atomicWrite(file: string, text: string | Uint8Array) {
  mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  // One read-write handle: Windows refuses fsync on a read-only one, and it cannot open a directory at all, so there the file flush is the whole guarantee.
  const fd = openSync(temporary, 'w+', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  if (process.platform === 'win32') return;
  const parent = openSync(resolve(file, '..'), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
const otherWriter = (file: string) => new Error(`Another process wrote ${file}. Close every other Pi on this profile and restart Pi; nothing was written.`);
/** With `size`, refuses to append unless the file still has that size. A last line left without its newline is ended first. A write
 * cut short is truncated away before the error is thrown. Returns the new size. */
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
        // Windows refuses to truncate through an append handle, so truncate by path.
        truncateSync(file, length);
      }
    }
    const data = Buffer.from(JSON.stringify(value) + '\n');
    // A cut-short write is undone, so the file keeps the size the caller checks against. If the undo fails too, the write's own
    // error is still the one thrown.
    try { if (writeSync(fd, data) !== data.length) throw new Error(`Incomplete write: ${file}`); }
    catch (error) { try { truncateSync(file, length); } catch {} throw error; }
    fsyncSync(fd);
    return fstatSync(fd).size;
  } finally { closeSync(fd); }
}
/** Where a record's line lies in its file: bytes `offset` to `offset + length`, newline excluded. */
type Located = (value: unknown, file: string, offset: number, length: number) => void;
function records(dir: string, warn: (s: string) => void, located?: Located): unknown[] {
  if (!existsSync(dir)) return [];
  const result: unknown[] = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()) {
    const file = join(dir, name), data = readFileSync(file);
    let from = 0, index = 0;
    // Newline is the append commit marker. Even a parseable unterminated tail may be a write interrupted before commit.
    for (let newline = data.indexOf(0x0a); newline >= 0; from = newline + 1, newline = data.indexOf(0x0a, from)) {
      index++;
      const line = data.toString('utf8', from, newline);
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { warn(`Skipped damaged JSON at ${file}:${index}`); continue; }
      result.push(value); located?.(value, file, from, newline - from);
    }
    if (data.toString('utf8', from).trim()) warn(`Skipped damaged JSON at ${file}:${index + 1}`);
  }
  return result;
}
/** The text of message `i` in the line at `offset`, refusing a line that no longer holds it. */
function lineText(data: Buffer, offset: number, length: number, i: number, file: string) {
  const moved = () => new Error(`Message ${i} is no longer where it was in ${file}; restart Pi to reload the memory.`);
  let record: { i?: unknown; text?: unknown } | null;
  try { record = JSON.parse(data.toString('utf8', offset, offset + length)); } catch { throw moved(); }
  if (record?.i !== i || typeof record.text !== 'string') throw moved();
  return record.text;
}
/** How long a log file read for an old message stays in RAM: a scan over a range reads each file once. */
const READ_CACHE_MS = 1000;

/** Memory as files in one directory: `main/` and `tree/` hold dated JSONL, each line fsynced as it is appended; `view.json` and
 * `images/<hash>.<ext>` are replaced atomically. Every write is done when it returns. */
export class FileStore implements Store {
  /** Each log file's size as this store last left it, so a write by another process is refused instead of interleaved. */
  private readonly lastSeenBytes = new Map<string, number>();
  /** Where each message's line is, by message index, so its text can be read back. */
  private readonly lines = new Map<number, { file: string; offset: number; length: number }>();
  private cached?: { file: string; data: Buffer; timer: ReturnType<typeof setTimeout> };
  constructor(readonly directory: string, private readonly warn: (s: string) => void = console.error) {}
  load(): Saved {
    for (const sub of ['main', 'tree']) mkdirSync(join(this.directory, sub), { recursive: true, mode: 0o700 });
    this.lines.clear();
    const main = join(this.directory, 'main'), entries = records(main, this.warn, (value, file, offset, length) => {
      const i = (value as { i?: unknown } | null)?.i;
      if (Number.isSafeInteger(i)) this.lines.set(i as number, { file, offset, length });
    });
    for (const name of readdirSync(main).filter(n => n.endsWith('.jsonl'))) this.lastSeenBytes.set(join(main, name), statSync(join(main, name)).size);
    const view = join(this.directory, 'view.json');
    // An unreadable view is rebuilt, as a damaged one is.
    let saved: string | undefined;
    if (existsSync(view)) try { saved = readFileSync(view, 'utf8'); } catch { saved = ''; }
    return { entries, tree: records(join(this.directory, 'tree'), this.warn), view: saved };
  }
  append(entry: Entry): undefined {
    const file = join(this.directory, 'main', `${localDay()}.jsonl`);
    if (!this.lastSeenBytes.has(file)) this.checkLog(file);
    const length = Buffer.byteLength(JSON.stringify(entry)), size = appendJson(file, entry, this.lastSeenBytes.get(file) ?? 0);
    this.lastSeenBytes.set(file, size);
    this.lines.set(entry.i, { file, offset: size - length - 1, length });
    if (this.cached?.file === file) this.drop();
  }
  reader(i: number) {
    const line = this.lines.get(i);
    return line && (() => lineText(this.read(line.file), line.offset, line.length, i, line.file));
  }
  private read(file: string) {
    if (this.cached?.file === file) { this.cached.timer.refresh(); return this.cached.data; }
    this.drop();
    const data = readFileSync(file), timer = setTimeout(() => this.drop(), READ_CACHE_MS);
    timer.unref();
    this.cached = { file, data, timer };
    return data;
  }
  private drop() { if (this.cached) clearTimeout(this.cached.timer); this.cached = undefined; }
  private checkLog(next: string) {
    const main = dirname(next), names = readdirSync(main).filter(n => n.endsWith('.jsonl'));
    if (names.length !== this.lastSeenBytes.size || names.some(n => statSync(join(main, n)).size !== this.lastSeenBytes.get(join(main, n)))) throw otherWriter(next);
  }
  appendNode(node: Summary | TerminalRecord): undefined {
    appendJson(join(this.directory, 'tree', `${localDay()}.jsonl`), node);
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
