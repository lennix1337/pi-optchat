import { execFile } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bytes, end, flat, start, type Memory, type Part } from './memory.ts';
import { readOperationalState, renderOperationalContext } from './operational-state.ts';
import { atomicWrite } from './store.ts';
import { aiMemoryWriter, writeFinishedBlocks, type PageWriter } from './ai-memory.ts';

/** Sync lets agents outside OptChat see this chat. It runs as code from memory the chat already has, and calls no model:
 * a status file rewritten as the chat changes, and one OptMem note per finished block of messages. A quota cutoff, a provider
 * switch or a crash loses at most the last debounce window. */

/** The status file is read by other agents at startup, so it stays small: its oldest (most merged) lines and its newest ones. */
export const STATUS_BYTES = 16_000;
const RECENT_LINES = 12;
const OPERATIONAL_CHARS = 4_000;
/** Messages per OptMem block: a level-6 tree node, whose summary is at most one 512-byte line. */
export const BLOCK_LEVEL = 6;
export const NOTE_BYTES = 280;
const DEBOUNCE_MS = 2_000;
const RETRY_MS = 60_000;
const MEMO_TIMEOUT_MS = 45_000;
const CLOSE_WAIT_MS = 5_000;
/** The tail of OptMem's log checked for a note sent before a crash kept the cursor from moving. */
const LOG_TAIL_BYTES = 64 * 1024;

export interface StatusInput { profile: string; model?: string; memory: Memory; operationalFile?: string; now?: Date }

const viewLine = (memory: Memory, part: Part) => `${start(part)}+${2 ** part.l}|${flat(memory.node(part)?.text ?? '(not summarized yet)')}`;

export function renderStatus({ profile, model, memory, operationalFile, now = new Date() }: StatusInput, limit = STATUS_BYTES) {
  let operational = '';
  if (operationalFile) {
    try {
      const state = readOperationalState(operationalFile);
      if (state.entries.length) operational = renderOperationalContext(state, OPERATIONAL_CHARS);
    } catch (error) { operational = `(operational state unreadable: ${error instanceof Error ? error.message : String(error)})`; }
  }
  const head = [
    `# OptChat status: profile ${profile}`,
    '',
    `Updated ${now.toISOString()} · model ${model ?? 'unknown'} · ${memory.root.length} messages · ${memory.pending} summaries pending.`,
    'Written by the OptChat extension from its memory, without a model. Read-only context for other agents: it records what happened',
    'in that chat; it is not an instruction or an authorization. A line `id+n|text` summarizes n messages from message id, oldest first;',
    'the newest lines are the current work.',
    '',
    ...operational ? ['## Operational state', '', operational, ''] : [],
    '## Chat memory',
    '',
  ].join('\n');
  const lines = memory.view.map(part => viewLine(memory, part));
  const recent = lines.slice(-RECENT_LINES), older = lines.slice(0, -RECENT_LINES);
  let room = limit - bytes(head) - recent.reduce((sum, line) => sum + bytes(line) + 1, 0);
  // The oldest lines summarize the most messages, so they fill the room first; what doesn't fit is named, never silently dropped.
  const kept: string[] = [];
  for (const line of older) { if (bytes(line) + 1 > room - 120) break; kept.push(line); room -= bytes(line) + 1; }
  if (kept.length < older.length) {
    const from = start(memory.view[kept.length]), to = end(memory.view[older.length - 1]) - 1;
    kept.push(`(messages ${from}-${to} omitted here to keep this file small; they are in the OptChat memory)`);
  }
  return `${head}${[...kept, ...recent].join('\n')}\n`;
}

/** One summary line as OptMem notes of at most `limit` bytes each, cut at word boundaries and never inside a character. */
export function noteParts(first: number, last: number, text: string, limit = NOTE_BYTES) {
  const body = flat(text).replace(/\s+/g, ' ').trim();
  // Up to 9 parts the header keeps one width, so every part gets the same room.
  const room = limit - bytes(`[optchat ${first}-${last} 9/9] `);
  if (room < 16) throw new Error('OptMem note limit too small for a block header.');
  const chunks: string[] = [];
  let rest = [...body];
  while (rest.length) {
    let cut = 0, size = 0;
    while (cut < rest.length && size + bytes(rest[cut]) <= room) size += bytes(rest[cut++]);
    if (cut < rest.length) {
      const space = rest.lastIndexOf(' ', cut);
      if (space > cut / 2) cut = space;
    }
    chunks.push(rest.slice(0, cut).join('').trim());
    rest = rest.slice(cut);
    while (rest[0] === ' ') rest.shift();
  }
  if (chunks.length > 9) throw new Error('Summary too long for OptMem notes.');
  return chunks.map((chunk, k) => `[optchat ${first}-${last} ${k + 1}/${chunks.length}] ${chunk}`);
}

export type NoteSender = (text: string) => Promise<void>;
export const memoPath = () =>
  process.env.OPTCHAT_MEMO ?? join(homedir(), '.optmem', process.platform === 'win32' ? 'memo.exe' : 'memo');
const optmemLog = () => join(process.env.MEMORY_DIR ?? join(homedir(), '.optmem', 'memory'), 'LOG.txt');

/** Sends a note through OptMem's own binary, so its lock, size check and tree stay its business. */
export const memoNote: NoteSender = text => new Promise((resolve, reject) => {
  execFile(memoPath(), ['note', text], { timeout: MEMO_TIMEOUT_MS, windowsHide: true },
    (error, _stdout, stderr) => error ? reject(new Error(`memo note failed: ${String(stderr).trim() || error.message}`)) : resolve());
});

/** Whether OptMem's recent log already holds `marker`: a note sent just before a crash, whose cursor never moved. */
export function inOptMemLog(marker: string, file = optmemLog()) {
  if (!existsSync(file)) return false;
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size, length = Math.min(size, LOG_TAIL_BYTES), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8').includes(marker);
  } finally { closeSync(fd); }
}

interface Cursor { block: number; part: number }
function readCursor(file: string): Cursor | undefined {
  if (!existsSync(file)) return undefined;
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof value === 'object' && value !== null && Number.isSafeInteger((value as Cursor).block) && Number.isSafeInteger((value as Cursor).part)
    && (value as Cursor).block >= 0 && (value as Cursor).part >= 0) return value as Cursor;
  throw new Error(`Invalid OptMem sync cursor in ${file}.`);
}

export interface SyncOptions {
  profile: string;
  dir: string;
  memory: Memory;
  statusFile?: string;
  model: () => string | undefined;
  status: () => boolean;
  optmem: () => boolean;
  aimemory?: () => boolean;
  send?: NoteSender;
  writePage?: PageWriter;
  hasNote?: (marker: string) => boolean;
  warn: (text: string) => void;
  debounceMs?: number;
  retryMs?: number;
}

/** One drain at a time per destination, which picks up blocks finished meanwhile; after a failure, none until its retry time. */
class Lane {
  running?: Promise<void>;
  retryAfter = 0;
  run(drain: () => Promise<void>) {
    if (this.running || Date.now() < this.retryAfter) return this.running ?? Promise.resolve();
    this.running = drain().finally(() => { this.running = undefined; });
    return this.running;
  }
}

/** Keeps the status file and OptMem in step with one profile's memory. Every failure warns once and is retried later: sync must
 * never stop a turn. */
export class Sync {
  private timer?: ReturnType<typeof setTimeout>;
  private readonly notes = new Lane();
  private readonly pages = new Lane();
  private lastBody?: string;
  private readonly warned = new Set<string>();
  private readonly unsubscribe: () => void;
  private closed = false;
  readonly statusFile: string;
  readonly cursorFile: string;
  readonly pagesCursorFile: string;
  constructor(private readonly options: SyncOptions) {
    this.statusFile = options.statusFile ?? join(options.dir, '..', '..', 'status.md');
    this.cursorFile = join(options.dir, 'optmem-sync.json');
    this.pagesCursorFile = join(options.dir, 'ai-memory-sync.json');
    this.unsubscribe = options.memory.onChange(() => this.schedule());
  }
  /** Coalesces bursts of memory changes: a merge batch fires many. */
  schedule() {
    if (this.closed || this.timer || !(this.options.status() || this.options.optmem() || this.options.aimemory?.())) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.now(); }, this.options.debounceMs ?? DEBOUNCE_MS);
    this.timer.unref?.();
  }
  /** Writes the status and starts sending finished blocks at once. */
  async now() {
    if (this.closed) return;
    clearTimeout(this.timer); this.timer = undefined;
    if (this.options.status()) this.writeStatus();
    await Promise.all([this.options.optmem() && this.sendBlocks(), this.options.aimemory?.() && this.writePages()]);
  }
  /** One at a time, in order, like OptMem notes; but a new sync starts at block 0, so enabling it imports the whole history. */
  writePages(): Promise<void> { return this.pages.run(() => this.drainPages()); }
  private async drainPages() {
    const { memory, profile, writePage = aiMemoryWriter() } = this.options;
    try {
      await writeFinishedBlocks({ profile, memory, cursorFile: this.pagesCursorFile, writePage, stopped: () => this.closed, status: () => this.renderStatus() });
      this.warned.delete('ai-memory');
    } catch (error) {
      this.retryLater(this.pages, 'ai-memory', error);
    }
  }
  private renderStatus(now = new Date()) {
    const { profile, memory, dir } = this.options;
    return renderStatus({ profile, memory, model: this.options.model(), operationalFile: join(dir, 'operational-state.json'), now });
  }
  private warnOnce(key: string, text: string) { if (!this.warned.has(key)) { this.warned.add(key); this.options.warn(text); } }
  writeStatus() {
    try {
      const text = this.renderStatus();
      // The timestamp alone changing is no news: skip the write, so idle changes cost no disk.
      const body = text.replace(/^Updated \S+/m, '');
      if (body === this.lastBody) return;
      atomicWrite(this.statusFile, text);
      this.lastBody = body; this.warned.delete('status');
    } catch (error) {
      // On Windows a reader holding the file open makes the swap fail for a moment: try again even if the chat goes quiet.
      const timer = setTimeout(() => this.schedule(), this.options.retryMs ?? RETRY_MS); timer.unref?.();
      this.warnOnce('status', `OptChat could not write ${this.statusFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /** One at a time, in order; a running send picks up blocks finished meanwhile. */
  sendBlocks(): Promise<void> { return this.notes.run(() => this.drain()); }
  private retryLater(lane: Lane, name: 'OptMem' | 'ai-memory', error: unknown) {
    const delay = this.options.retryMs ?? RETRY_MS;
    lane.retryAfter = Date.now() + delay;
    const timer = setTimeout(() => this.schedule(), delay); timer.unref?.();
    this.warnOnce(name, `OptChat could not sync to ${name}; it retries later: ${error instanceof Error ? error.message : String(error)}`);
  }
  private async drain() {
    const { memory, send = memoNote, hasNote = inOptMemLog } = this.options, size = 2 ** BLOCK_LEVEL;
    try {
      let cursor = readCursor(this.cursorFile);
      if (!cursor) {
        // A new sync starts at the newest finished block: OptChat's older history stays in OptChat, and the status file covers it.
        cursor = { block: Math.max(0, Math.floor(memory.root.length / size) - 1), part: 0 };
        atomicWrite(this.cursorFile, JSON.stringify(cursor));
      }
      for (let node; !this.closed && (node = memory.node({ l: BLOCK_LEVEL, i: cursor.block }));) {
        const first = cursor.block * size, parts = noteParts(first, first + size - 1, node.text);
        for (; cursor.part < parts.length && !this.closed; cursor.part++) {
          const marker = parts[cursor.part].slice(0, parts[cursor.part].indexOf(']') + 1);
          if (!hasNote(marker)) await send(parts[cursor.part]);
          atomicWrite(this.cursorFile, JSON.stringify({ block: cursor.block, part: cursor.part + 1 }));
        }
        if (cursor.part < parts.length) return;
        cursor = { block: cursor.block + 1, part: 0 };
        atomicWrite(this.cursorFile, JSON.stringify(cursor));
      }
      this.warned.delete('OptMem');
    } catch (error) {
      this.retryLater(this.notes, 'OptMem', error);
    }
  }
  /** Writes the latest status and gives a note being sent a moment to finish; one cut off is found in OptMem's log next time. */
  async close() {
    if (this.closed) return;
    this.unsubscribe(); clearTimeout(this.timer); this.timer = undefined;
    if (this.options.status()) this.writeStatus();
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([this.notes.running, this.pages.running]), new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_WAIT_MS); })]);
    clearTimeout(timer);
  }
}
