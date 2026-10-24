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
export interface CacheOptions { prefix?: 'short' | 'long' }
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

const viewMark = (back: number, options: CacheOptions) => ({ type: 'ephemeral', ...(options.prefix === 'long' && back === LONG_VIEW_BACK ? { ttl: '1h' } : {}) });

/** Anthropic: marks on the view (see MARKS) plus automatic end-of-request caching, so the next call finds the last one's entry
 * and pays only for the lines after it. */
export function cachePayload(payload: unknown, options: CacheOptions = {}): unknown {
  if (!record(payload) || !Array.isArray(payload.messages)) return payload;
  const offsets = options.prefix ? PREFIX_MARKS : MARKS;
  const messages = payload.messages;
  const view = new Set<unknown>();
  for (const message of messages) {
    if (!record(message) || message.role !== 'user' || !Array.isArray(message.content)) continue;
    const at = message.content.findIndex((block: unknown) => record(block) && block.type === 'text' && typeof block.text === 'string' && isView(block.text));
    if (at < 0) continue;
    const pieces = splitView(message.content[at].text);
    const blocks = pieces.map((text, j) => {
      const back = offsets.find(offset => pieces.length - 2 - offset === j);
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
