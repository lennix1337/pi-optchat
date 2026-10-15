import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { Memory, Part } from './memory.ts';

export function summaryPart(value: string): Part {
  const match = /^(0|[1-9]\d*)\+([1-9]\d*)$/.exec(value.trim());
  if (!match) throw new Error('Usage: /optchat retry-summary <start>+<size>, for example 0+1');
  const start = Number(match[1]), size = Number(match[2]), level = Math.log2(size);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || !Number.isInteger(level) || start % size !== 0)
    throw new Error('Summary range must have a power-of-two size and an aligned start');
  return { l: level, i: start / size };
}
/** Explicit user command only: never a recovery callback or provider-switch strategy. */
export async function retrySummary(memory: Memory, args: string, ctx: Pick<ExtensionCommandContext, 'isIdle'> & { ui: Pick<ExtensionCommandContext['ui'], 'notify'> }) {
  if (!ctx.isIdle()) throw new Error('Wait until the current turn ends before explicitly retrying a summary');
  const part = summaryPart(args);
  const retried = await memory.retryRefused(part);
  ctx.ui.notify(retried
    ? 'Summary retry requested with the current configured compactor. This does not retry the main request or change providers; another refusal will stop the node again.'
    : 'That node is not policy-blocked; no retry was requested.', 'info');
}
