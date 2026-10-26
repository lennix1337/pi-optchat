import { createHash } from 'node:crypto';
import { COLD_LONG_MS, COLD_MS, isView } from './memory.ts';
import { STATUS_NOTE } from './prompts.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The view in blocks of 4 lines counted from its start (recipe §3.3), byte for byte. While the view only grows at its end,
 * every block but the last is the same in the next call. */
export function splitView(text: string) {
  const pieces: string[] = [];
  let offset = 0;
  for (let count = 0, at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1))
    if (++count % 4 === 0) { pieces.push(text.slice(offset, at + 1)); offset = at + 1; }
  pieces.push(text.slice(offset));
  return pieces;
}

/** How many blocks before the view's last whole one each mark sits. Anthropic looks back only 20 blocks from a mark for an
 * earlier entry, so the marks 20 and 40 blocks back still find the last call's entry after a turn of tool calls adds up to
 * 60 blocks (240 lines). With the end of the request, that is Anthropic's limit of 4 marks. */
const MARKS = [0, 20, 40];
/** With a prefix mark, the view keeps two: a turn can then add up to 40 blocks (160 lines) and still find the last call's entry. */
const PREFIX_MARKS = [0, 20];
/** With `long`, the older of those (20 blocks back) takes the 1-hour entry as well. Its prefix changes only when a batch merge rewrites
 * the view from near its top, so it can outlive a 5-minute gap. A 1-hour write costs 2x input against 1.25x for 5 minutes, and the
 * extra pays off when the entry is read after such a gap (a read costs 0.1x). The newer view mark and the request's end stay at 5 minutes. */
const LONG_VIEW_BACK = 20;
/** `prefix` also marks the system prompt, and with it the tools before it, at the cost of the view's oldest mark. They change
 * only with the session's setup, while the view's batch merges rewrite it from near its top every ~150 messages: replayed
 * over the profile's log, a quarter of turn starts found no view entry, and with no mark before the view each rewrote the
 * ~18K-token system prompt and tools too. `long` keeps that entry an hour, past the 5-minute gaps between most turns, for a
 * write premium paid only when the prefix changes. Leave it off where the system prompt is too short to cache (the compactor). */
export interface CacheOptions { prefix?: 'short' | 'long'; entries?: ViewEntries }

/** Anthropic's lookback from a mark, in blocks. */
const LOOKBACK = 20;
const TTL_MS = { '5m': 300_000, '1h': 3_600_000 } as const;
/** Forget an entry a little before Anthropic does, so a mark is never put on one already gone. */
const TTL_MARGIN_MS = 15_000;
const ENTRIES = 64;
/** A call's view against the last call's, so a cache miss in usage.jsonl can be told apart: the view rewritten from `changedAt`
 * (a batch merge near the top), a changed head (system, tools, model, thinking), or a view that only grew (null: lookback or expiry). */
export interface ViewReport { date: string; model?: string; gapMs?: number; blocks: number; changedAt?: number | null; headChanged?: boolean; marks: number[] }
/** The view blocks earlier calls marked, by a digest of the whole request up to and including the block. When a view grows by
 * more than its marks can look back (a turn moved into memory, a long turn folded in at the next one), the next call puts one
 * mark back on the newest of those blocks still unchanged and alive, and reads that entry instead of writing the view again. */
export class ViewEntries {
  private readonly entries = new Map<string, { at: number; until: number; ttl: keyof typeof TTL_MS }>();
  private previous?: { base: string; chain: readonly string[]; time: number };
  last?: ViewReport;
  constructor(private readonly now = () => Date.now(), private readonly report?: (report: ViewReport) => void) {}
  /** Compare this call's view with the last call's: `changedAt` is the first block that differs (null: it only grew). The last
   * piece is not a whole block (it ends with the view's close), so growth changes it. */
  observe(base: string, chain: readonly string[], marks: Iterable<number>, model?: unknown) {
    const before = this.previous, time = this.now();
    let changedAt: number | null | undefined;
    if (before) {
      const whole = Math.min(chain.length, before.chain.length) - 1;
      const index = chain.findIndex((digest, block) => block < whole && digest !== before.chain[block]);
      changedAt = index >= 0 ? index : chain.length < before.chain.length ? whole : null;
    }
    this.previous = { base, chain, time };
    this.last = { date: new Date(time).toISOString(), ...(typeof model === 'string' ? { model } : {}), gapMs: before && time - before.time,
      blocks: chain.length, changedAt, headChanged: before && before.base !== base, marks: [...marks].sort((a, b) => a - b) };
    this.report?.(this.last);
  }
  /** The newest block of `chain` (digests by block) an earlier call marked, whose entry still lives. */
  latest(chain: readonly string[]): number | undefined {
    const time = this.now();
    let found: number | undefined;
    for (const [digest, entry] of this.entries) {
      if (entry.until <= time) this.entries.delete(digest);
      else if (chain[entry.at] === digest && (found === undefined || entry.at > found)) found = entry.at;
    }
    return found;
  }
  /** What this call's marks (block -> TTL) leave at Anthropic, before `observe`. Anthropic reads the newest entry the request
   * reaches, refreshing it, and writes entries only at the marks after it: a mark before it leaves nothing. Within 5 minutes
   * of a call whose request this one repeats through the view, that is the last call's entry at the end of its request, so no
   * view mark is written or refreshed. Counting those marks as entries sent the next turn back to blocks Anthropic never
   * cached (session 01a1704e, 2026-10-26: every turn start that found the view read an entry an earlier turn start wrote). */
  record(chain: readonly string[], marks: ReadonlyMap<number, keyof typeof TTL_MS>) {
    const before = this.previous?.chain;
    if (before && this.now() - this.previous!.time < TTL_MS['5m'] - TTL_MARGIN_MS && before.length === chain.length
      && before.every((digest, block) => digest === chain[block])) return;
    const read = this.latest(chain);
    if (read !== undefined && !marks.has(read)) this.marked(chain[read], read, this.entries.get(chain[read])!.ttl);
    for (const [block, ttl] of marks) if (read === undefined || block >= read) this.marked(chain[block], block, ttl);
  }
  /** A mark on block `at`: its entry is written or read, and lives `ttl` from now either way. */
  private marked(digest: string, at: number, ttl: keyof typeof TTL_MS) {
    const entry = this.entries.get(digest), until = Math.max(this.now() + TTL_MS[ttl] - TTL_MARGIN_MS, entry?.until ?? 0);
    this.entries.delete(digest);
    this.entries.set(digest, { at, until, ttl: entry?.ttl === '1h' ? '1h' : ttl });
    while (this.entries.size > ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }
}
/** Digest of everything Anthropic caches before the view's first block (model, thinking, tools, system, earlier messages and
 * blocks), then one per block, each over the one before: equal digests mean an equal request prefix. */
function viewChain(payload: Record<string, unknown>, messages: unknown[], index: number, at: number, pieces: readonly string[]) {
  const message = messages[index] as { content: unknown[] };
  const before = JSON.stringify([payload.model, payload.thinking, payload.output_config, payload.tools, payload.system, messages.slice(0, index),
    message.content.slice(0, at)], (key, value) => key === 'cache_control' ? undefined : value);
  const chain: string[] = [];
  const base = createHash('sha256').update(before).digest('hex');
  let digest = base;
  for (const piece of pieces) chain.push(digest = createHash('sha256').update(digest).update(piece).digest('hex'));
  return { base, chain };
}
/** Anthropic's own API takes the 1-hour TTL; other endpoints speaking its protocol may not, so they keep the 5-minute one. */
export const prefixRetention = (model?: { provider?: string; compat?: unknown }): 'short' | 'long' =>
  model?.provider === 'anthropic' && !(record(model.compat) && model.compat.supportsLongCacheRetention === false) ? 'long' : 'short';
/** How long a merge of the chat view waits after the last request: the 1-hour entry lasts that long, the 5-minute one does not. */
export const coldAfter = (model?: { provider?: string; compat?: unknown }) => prefixRetention(model) === 'long' ? COLD_LONG_MS : COLD_MS;

/** OptChat's status line (agents and background shells at work), in Pi's context and in Anthropic's payload alike. */
export const isAtWork = (message: unknown) => record(message) && message.role === 'user' && Array.isArray(message.content) && message.content.length === 1
  && record(message.content[0]) && typeof message.content[0].text === 'string' && message.content[0].text.startsWith(STATUS_NOTE);
function lastBlock(message: Record<string, unknown>) {
  if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }];
  const block: unknown = Array.isArray(message.content) ? message.content.at(-1) : undefined;
  return record(block) ? block : undefined;
}

const viewMark = (back: number, options: CacheOptions): { type: 'ephemeral'; ttl?: '1h' } =>
  ({ type: 'ephemeral', ...(options.prefix === 'long' && back === LONG_VIEW_BACK ? { ttl: '1h' as const } : {}) });

/** Where the view's marks go: block -> how far back from the last whole block the mark was meant to be, which sets its TTL.
 * With `chain`, a live entry an earlier call wrote that no usual mark reaches takes the oldest mark's place (keeping its TTL),
 * or a free one on a view too short for all of them. */
function viewMarks(pieces: readonly string[], offsets: readonly number[], entries?: ViewEntries, chain?: readonly string[]) {
  const last = pieces.length - 2;
  const marks = new Map(offsets.filter(back => last - back >= 0).map(back => [last - back, back]));
  const found = chain && entries?.latest(chain.slice(0, last + 1));
  if (found === undefined || [...marks.keys()].some(block => block >= found && block - found <= LOOKBACK)) return marks;
  const oldest = marks.size < offsets.length ? undefined : Math.min(...marks.keys());
  const back = oldest === undefined ? offsets.at(-1)! : marks.get(oldest)!;
  if (oldest !== undefined) marks.delete(oldest);
  return marks.set(found, back);
}

/** Anthropic: marks on the view (see MARKS) plus automatic end-of-request caching, so the next call finds the last one's entry
 * and pays only for the lines after it. */
export function cachePayload(payload: unknown, options: CacheOptions = {}): unknown {
  if (!record(payload) || !Array.isArray(payload.messages)) return payload;
  const offsets = options.prefix ? PREFIX_MARKS : MARKS;
  const messages = payload.messages;
  const view = new Set<unknown>();
  for (const [index, message] of messages.entries()) {
    if (!record(message) || message.role !== 'user' || !Array.isArray(message.content)) continue;
    const at = message.content.findIndex((block: unknown) => record(block) && block.type === 'text' && typeof block.text === 'string' && isView(block.text));
    if (at < 0) continue;
    const pieces = splitView(message.content[at].text);
    const digests = options.entries && viewChain(payload, messages, index, at, pieces);
    const chain = digests?.chain;
    const marks = viewMarks(pieces, offsets, options.entries, chain);
    if (digests) {
      options.entries!.record(digests.chain, new Map([...marks].map(([block, back]) => [block, viewMark(back, options).ttl ?? '5m'])));
      options.entries!.observe(digests.base, digests.chain, marks.keys(), payload.model);
    }
    const blocks = pieces.map((text, j) => {
      const back = marks.get(j);
      return { type: 'text', text, ...(back === undefined ? {} : { cache_control: viewMark(back, options) }) };
    });
    message.content.splice(at, 1, ...blocks);
    for (const block of blocks) view.add(block);
    break;
  }
  if (!view.size) return payload;
  // These marks only: Pi's own system, tool and recent-message marks are dropped.
  for (const section of [payload.system, payload.tools]) {
    if (Array.isArray(section)) for (const item of section) if (record(item)) delete item.cache_control;
  }
  for (const message of messages) {
    if (!record(message)) continue;
    delete message.cache_control;
    if (Array.isArray(message.content)) for (const item of message.content) if (record(item) && !view.has(item)) delete item.cache_control;
  }
  if (options.prefix) {
    if (typeof payload.system === 'string' && payload.system) payload.system = [{ type: 'text', text: payload.system }];
    const last: unknown = Array.isArray(payload.system) && payload.system.length ? payload.system.at(-1) : Array.isArray(payload.tools) ? payload.tools.at(-1) : undefined;
    if (record(last)) last.cache_control = { type: 'ephemeral', ...(options.prefix === 'long' ? { ttl: '1h' } : {}) };
  }
  // The status line changes between calls, so the turn's mark goes on the block before it rather than at the end of the request.
  // Pi may end the request with an empty system message carrying settings (effort); it holds nothing to cache.
  const [before, last] = messages.filter(message => !record(message) || message.role !== 'system').slice(-2);
  const turn = isAtWork(last) && record(before) && before.role === 'user' ? lastBlock(before) : undefined;
  if (turn) turn.cache_control = { type: 'ephemeral' };
  else payload.cache_control = { type: 'ephemeral' };
  return payload;
}
