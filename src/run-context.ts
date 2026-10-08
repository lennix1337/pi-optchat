import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { bytes, VIEW } from './memory.ts';

const inputBudget = (window: number) => window - Math.min(16_384, Math.ceil(window / 4));
const estimatedTokens = (messages: readonly AgentMessage[]) => messages.reduce((sum, message) => sum + estimateTokens(message), 0);
/** Provider usage covers the previous request, not tool output appended since. After a refresh, old usage is stale and must not be reused. */
function requestTokens(messages: readonly AgentMessage[]) {
  const at = messages.findLastIndex(message => message.role === 'assistant' && message.usage.input + message.usage.cacheRead + message.usage.cacheWrite > 0);
  const message = messages[at];
  if (message?.role !== 'assistant') return estimatedTokens(messages);
  return message.usage.input + message.usage.cacheRead + message.usage.cacheWrite + estimatedTokens(messages.slice(at));
}
export function needsRunRefresh(messages: readonly AgentMessage[], run: readonly AgentMessage[], window: number) {
  return bytes(JSON.stringify(run)) > VIEW || requestTokens(messages) > inputBudget(window);
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
export function assertContextFits(messages: readonly AgentMessage[], window: number) {
  if (estimatedTokens(messages) > inputBudget(window)) throw new Error('OptChat context is still too large after refresh. Reduce the current input or use a larger-context model; originals are preserved.');
}
