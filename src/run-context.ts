import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { bytes, VIEW } from './memory.ts';

const DEFAULT_OUTPUT_RESERVE = 16_384;
// Extra input headroom for the tokenizer heuristic and provider framing not represented in Pi messages.
const ESTIMATE_MARGIN = 0.05;
/** Share of a price tier's threshold a request may fill: Pi estimates the newest messages, and one tool result can add many tokens. */
const TIER_HEADROOM = 0.9;
/** The prompt size a model's request should stay under so it keeps its base price: the lowest `cost.tiers` threshold in Pi's
 * model table (Pi prices every token of a request at the tier its whole input, cache included, reaches), with headroom. */
export function priceTierBudget(model?: { cost?: { tiers?: readonly { inputTokensAbove: number }[] } }) {
  const limits = (model?.cost?.tiers ?? []).map(tier => tier.inputTokensAbove).filter(limit => limit > 0);
  return limits.length ? Math.floor(Math.min(...limits) * TIER_HEADROOM) : undefined;
}
export function inputTokenBudget(window: number, maxOutputTokens?: number) {
  const output = Math.min(window, Math.max(0, maxOutputTokens ?? Math.min(DEFAULT_OUTPUT_RESERVE, Math.ceil(window / 4))));
  const margin = Math.ceil(window * ESTIMATE_MARGIN);
  return Math.max(0, Math.floor(window) - output - margin);
}
/** Pi's estimate over the full assembled transcript. Main callers must pass the `context_with_system` result, whose system
 * message has the current prompt and active `toolsAdded`; child sessions use Pi's built-in compactor over that same structure. */
export const estimatedContextTokens = (messages: readonly AgentMessage[]) => messages.reduce((sum, message) => sum + estimateTokens(message), 0);
/** Check the assembled request, not prior provider usage, which omits newly appended results and may be stale after refresh. */
export function needsRunRefresh(messages: readonly AgentMessage[], run: readonly AgentMessage[], window: number, maxOutputTokens?: number) {
  return bytes(JSON.stringify(run)) > VIEW || estimatedContextTokens(messages) > inputTokenBudget(window, maxOutputTokens);
}
/** All live user instructions remain exact. Older executed exchanges are now in the tree; the last exchange stays native for tool-call pairing. */
export function retainedRun(run: readonly AgentMessage[]): AgentMessage[] {
  const at = run.findLastIndex(message => message.role === 'assistant');
  if (at < 0) return [...run];
  const tail = run.slice(at), assistant = tail[0];
  if (assistant.role === 'assistant') {
    const results = new Set(tail.flatMap(message => message.role === 'toolResult' ? [message.toolCallId] : []));
    if (assistant.content.some(block => block.type === 'toolCall' && !results.has(block.id))) throw new Error('Cannot refresh an incomplete tool exchange.');
  }
  return [...run.slice(0, at).filter(message => message.role === 'user' || message.role === 'custom'), ...tail];
}
export function assertContextFits(messages: readonly AgentMessage[], window: number, maxOutputTokens?: number) {
  const tokens = estimatedContextTokens(messages), budget = inputTokenBudget(window, maxOutputTokens);
  if (tokens > budget) throw new Error(`OptChat context is too large: it needs about ${tokens} tokens, over its ${budget}-token input budget after the output reserve. Reduce the current input or use a larger-context model; originals are preserved.`);
}
