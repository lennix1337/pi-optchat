import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { reasoningFor, resolveModel, type ModelChoice } from './compactor.ts';

/** One cheap, thinking-free call whose first line must match `line`; throws on a failed call or an unclear answer. */
export async function askOneLine(registry: ModelRegistry, choice: ModelChoice, request: { systemPrompt: string; content: string; maxTokens: number; line: RegExp; what: string; cacheRetention?: 'none' | 'short' | 'long' },
  usage: (message: AssistantMessage) => void, signal: AbortSignal): Promise<{ word: string; reason: string; model: string }> {
  const resolved = resolveModel(registry, choice);
  if (!resolved) throw new Error(`${request.what} model unavailable: ${choice.provider}/${choice.model}`);
  const { model } = resolved;
  const reply = await registry.streamSimple(model, {
    systemPrompt: request.systemPrompt,
    messages: [{ role: 'user', timestamp: Date.now(), content: request.content }],
    // Temperature 0 where the API takes it (Codex rejects the parameter): the same call gets the same verdict,
    // so a sampling fluke cannot stop an approved call.
  }, { reasoning: reasoningFor(model, 'off'), maxTokens: request.maxTokens, ...(request.cacheRetention ? { cacheRetention: request.cacheRetention } : {}), ...(model.api === 'anthropic-messages' ? { temperature: 0 } : {}), signal }).result();
  usage(reply);
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? reply.stopReason);
  const text = reply.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('').trim();
  const match = request.line.exec(text.split('\n')[0] ?? '');
  if (!match) throw new Error(`no clear verdict from ${model.provider}/${model.id}: ${text.slice(0, 80) || '(empty)'}`);
  return { word: match[1].toUpperCase(), reason: match[2].trim() || '(no reason given)', model: `${model.provider}/${model.id}` };
}
