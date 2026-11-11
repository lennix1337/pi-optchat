import type { AgentBeforeSettleEvent, BoundaryResult, SessionEntry } from '@earendil-works/pi-coding-agent';

/** Marks a compaction written by housekeeping. pi-subagents and pi-goal-x read the same `details.housekeeping` flag. */
export const HOUSEKEEPING_DETAILS = { optchat: true, housekeeping: true } as const;
/** Housekeeping starts once Pi holds more than this many times `transcriptKeep` messages. */
export const HOUSEKEEPING_SLACK = 2;

export interface Cut { firstKeptEntryId: string; dropped: number; kept: number }

/** The entries that make Pi send a message to the model, or draw one in the chat. */
const counts = (entry: SessionEntry) => entry.type === 'message' || entry.type === 'custom_message';
const startsTurn = (entry: SessionEntry) => entry.type === 'custom_message' || entry.type === 'message' && entry.message.role === 'user';

/**
 * Where Pi's in-memory context and chat should start so at least `keep` messages stay: at the start of a turn (a user or extension
 * message), never between a tool call and its result. Undefined while the context holds at most HOUSEKEEPING_SLACK × keep messages,
 * so the chat is redrawn once per `keep` new messages, not on every run.
 */
export function housekeepingCut(context: readonly SessionEntry[], keep: number): Cut | undefined {
  if (keep <= 0) return;
  // The first entry of a compacted context is the compaction itself: it stays and is not counted.
  const entries = context[0]?.type === 'compaction' ? context.slice(1) : context;
  const total = entries.filter(counts).length;
  if (total <= keep * HOUSEKEEPING_SLACK) return;
  let seen = 0, start = entries.length;
  while (start > 0 && seen < keep) if (counts(entries[--start])) seen++;
  // Back to the turn start at or before the target, so at least `keep` messages stay; in one long turn, forward to the next
  // turn start or, failing that, to an assistant message. A cut that leaves nothing to drop is no cut.
  let cut = entries.findLastIndex((entry, i) => i <= start && startsTurn(entry));
  if (cut <= 0) cut = entries.findIndex((entry, i) => i >= start && startsTurn(entry));
  if (cut < 0) cut = entries.findIndex((entry, i) => i >= start && entry.type === 'message' && entry.message.role === 'assistant');
  if (cut <= 0) return;
  return { firstKeptEntryId: entries[cut].id, dropped: entries.slice(0, cut).filter(counts).length, kept: entries.slice(cut).filter(counts).length };
}

/**
 * Pi's own way to end a run with a compaction: a boundary entry, written before the run settles, with no model call. Pi then
 * rebuilds its in-memory list and redraws the chat from the kept entries. The session file and OptChat's memory keep every message,
 * and the model reads OptChat's own view of the chat (not Pi's list), so nothing the model is sent changes.
 *
 * Undefined while the run goes on (a retry, a queued message, an earlier handler asking to continue) or while Pi holds little.
 */
export function housekeepingBoundary(event: Pick<AgentBeforeSettleEvent, 'outcome' | 'continue' | 'context'>, context: readonly SessionEntry[], keep: number): BoundaryResult | undefined {
  if (event.outcome === 'error' || event.continue || event.context.canContinue || event.context.pendingMessages.length) return;
  const cut = housekeepingCut(context, keep);
  if (!cut) return;
  return { entries: [{ type: 'compaction', firstKeptEntryId: cut.firstKeptEntryId, details: HOUSEKEEPING_DETAILS,
    summary: `${cut.dropped} earlier messages left Pi's in-memory context to keep it small. They stay in the session file and in OptChat memory (zoom, date); the model reads OptChat's own view, which this does not change.` }] };
}
