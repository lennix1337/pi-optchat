import { setTimeout as sleep } from 'node:timers/promises';
import { clampThinkingLevel, type Api, type AssistantMessage, type Message, type Model, type Tool } from '@earendil-works/pi-ai';
import type { AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { accountGroup } from './profiles.ts';
import { PROMPT } from './recipe-prompt.ts';
import { IMPORT_GUIDANCE, SUMMARY_SIGNPOSTS, compaction, tooLong } from './prompts.ts';
import { bytes, NODE, start, type Compressor, type Compression, type Part } from './memory.ts';
import { cachePayload, splitView } from './cache.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { CompactorTrace, createCompactorIncidentId, errorCategory, type CompactorDiagnostic } from './compactor-diagnostics.ts';
import type { UsageAttribution } from './usage.ts';
import { assertContextFits } from './run-context.ts';

export interface ModelChoice { provider: string; model: string; thinking: ThinkingLevel }
/** The chosen model, with the base provider as the fallback: a numbered account that does not publish the model still runs it on the family's base account. */
export function resolveModel(registry: ModelRegistry, selected: ModelChoice): { provider: string; model: Model<Api> } | undefined {
  const model = registry.find(selected.provider, selected.model);
  if (model) return { provider: selected.provider, model };
  const base = accountGroup(selected.provider);
  const fallback = base === selected.provider ? undefined : registry.find(base, selected.model);
  return fallback && { provider: base, model: fallback };
}
/** A level the model can't take would be sent as no level, which Sonnet 5.5 runs at high effort; Pi's own sessions clamp the same way. */
export const reasoningFor = (model: Model<Api>, level: ThinkingLevel) => {
  const thinking = clampThinkingLevel(model, level);
  return thinking === 'off' ? undefined : thinking;
};

/** Models can't count bytes, so the task shows the limit as a ruler; a real sample line got its content copied (recipe §4). */
const RULER = '-'.repeat(NODE);
const label = (part: Part) => `${start(part)}+${2 ** part.l}`;
/** The recipe's compaction task. A tool result also gets the call that produced it, plus its output. */
export function task(input: { source: string; part: Part; result?: string; call?: { i: number; text: string } }, targetBytes?: number) {
  const { source, part, result, call } = input;
  const sizeHint = `${SUMMARY_SIGNPOSTS}\n` + (targetBytes === undefined ? '' : `Aim for at most ${targetBytes} UTF-8 bytes (not characters), leaving room below the limit.\n`);
  const callContext = call ? `\nThe call is in <call>: context, like <chat>.\n<call>\n${call.text}\n</call>` : '';
  if (!part.l) {
    const kind = /^(\w+): /.exec(source)?.[1];
    return `Compaction: compress message ${part.i}${kind ? `, kind ${kind},` : ''} into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${RULER}\n`
      + `Summarize <input> alone${kind ? `, starting with "${kind}:"` : ''}: the <chat> lines are other messages, never copy them in.\n${sizeHint}<input>\n${source}\n</input>`
      + callContext + (result === undefined ? '' : `\nThe call's result is in <result>: say in a few words what it found or did.\n<result>\n${result}\n</result>`);
  }
  const a = { l: part.l - 1, i: 2 * part.i }, b = { l: part.l - 1, i: 2 * part.i + 1 };
  return `Compaction: merge lines ${label(a)} and ${label(b)}, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${RULER}\n`
    + `<chat> may hold their messages, ${start(part)} to ${start(part) + 2 ** part.l - 1}, in more detail: take details\nof them from there too.\n${sizeHint}<input>\n${source}\n</input>`;
}

const WARM_MS = 4 * 60_000; // Anthropic's short cache lives 5 minutes from its last use.

/** Parallel calls can't read a cache entry that isn't written yet, so one call primes a cold prefix and the rest wait until its response starts. */
function primeFirst() {
  const warm = new Map<string, number | Promise<void>>();
  return async (prefix: string, signal: AbortSignal) => {
    const priming = () => { for (const [k, state] of warm) if (typeof state !== 'number' && prefix.startsWith(k)) return state; };
    for (let state = warm.get(prefix) ?? priming(); state !== undefined; state = warm.get(prefix) ?? priming()) {
      if (typeof state === 'number') { if (Date.now() - state < WARM_MS) break; warm.delete(prefix); continue; }
      signal.throwIfAborted();
      let wake = () => {};
      const aborted = new Promise<void>(resolve => { wake = resolve; });
      signal.addEventListener('abort', wake, { once: true });
      await Promise.race([state, aborted]);
      signal.removeEventListener('abort', wake);
      signal.throwIfAborted();
    }
    let release = () => {};
    const pending = warm.has(prefix) ? undefined : new Promise<void>(resolve => { release = resolve; });
    if (pending) warm.set(prefix, pending);
    return (ok: boolean) => {
      if (ok) { for (const [k, at] of warm) if (typeof at === 'number' && Date.now() - at >= WARM_MS) warm.delete(k); warm.set(prefix, Date.now()); }
      else if (warm.get(prefix) === pending) warm.delete(prefix);
      release();
    };
  };
}
/** What a compaction shares with the turns: the same system prompt and tools (never called) once available. */
export interface Shared { systemPrompt: string; tools?: Tool[] }
type IncidentContext = { sessionId?: string; recoveryIncidentId?: string };
function compactorError(error: unknown, detail: string) {
  if (errorCategory(error) !== 'stream_interrupted') return error;
  return new Error(`Compactor stream interrupted before a usable summary (${detail}); original messages are retained and the node will retry in the background.`, { cause: error });
}
function summaryText(reply: AssistantMessage, detail: string) {
  if (reply.stopReason === 'error') throw compactorError(new Error(reply.errorMessage ?? `Compactor error (${detail})`), detail);
  if (reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Compactor aborted (${detail})`);
  if (reply.stopReason === 'length') throw new Error(`Compactor response truncated (${detail}).`);
  if (reply.content.some(block => block.type === 'toolCall')) throw new Error(`Compactor returned a tool call instead of a summary (${detail}).`);
  const line = reply.content.filter(block => block.type === 'text').map(block => block.text).join('').trim().replace(/^\d+\+\d+\|\s*/, '');
  if (!line) throw new Error(`Compactor returned no text (${detail}; blocks=${reply.content.map(block => block.type).join(',') || 'none'}). See compactor-diagnostics.jsonl.`);
  return line;
}
function usageOutcome(outcome: string | undefined): UsageAttribution['outcome'] {
  switch (outcome) {
    case 'stop': case 'toolUse': case 'length': case 'error': case 'aborted':
    case 'text': case 'tool_call': case 'empty': case 'exception': return outcome;
    default: return undefined;
  }
}
const policyRefusalPattern = /\b(?:content|safety|usage)\s+policy\b|\bpolicy\s+(?:violation|refusal|rejection)\b|\b(?:blocked|rejected|refused)\s+by\s+(?:the\s+)?(?:provider\s+)?(?:content\s+|safety\s+|usage\s+)?policy\b|\bcontent[- ]filter\b/i;
function isPolicyRefusal(error: unknown) {
  const messages: string[] = [];
  for (let depth = 0; depth < 5 && typeof error === 'object' && error !== null; depth++) {
    if (error instanceof Error) { messages.push(error.message); error = error.cause; }
    else if ('errorMessage' in error && typeof error.errorMessage === 'string') { messages.push(error.errorMessage); break; }
    else break;
  }
  if (typeof error === 'string') messages.push(error);
  return policyRefusalPattern.test(messages.join('\n'));
}
const policyRefusalError = () => Object.assign(new Error('Compactor request rejected by provider policy.'), { code: 'OPTCHAT_POLICY_REFUSAL' as const });
function markPolicyRefusal(trace: CompactorTrace, error: unknown) {
  if (isPolicyRefusal(error)) trace.diagnostic.errorCategory = 'policy_refusal';
}
function retryable(error: unknown, trace: CompactorTrace, failures: number, retries: readonly number[], signal: AbortSignal) {
  const message = typeof error === 'object' && error !== null && 'errorMessage' in error && typeof error.errorMessage === 'string' ? error.errorMessage : undefined;
  if (isPolicyRefusal(error)) return false;
  const assistantReply = message !== undefined && typeof error === 'object' && error !== null && 'role' in error;
  const category = errorCategory(message ?? error);
  const interruptedBeforeResponse = category === 'stream_interrupted' && assistantReply
    && !trace.diagnostic.events.start && trace.diagnostic.nativeStatus === undefined;
  return !signal.aborted && failures < retries.length && trace.diagnostic.httpStatus !== 200
    && (category === 'connection_failure' || category === 'unavailable' || category === 'timeout' || interruptedBeforeResponse);
}
/** The model is asked for 512-byte lines; shared keeps turn prompts/tools aligned and each attempt records metadata only. */
export function createCompressor(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage, attribution: UsageAttribution) => void = () => {}, accepted = () => DEFAULT_SETTINGS.summaryAcceptBytes,
  sharedOrRetries: (() => Shared | undefined) | readonly number[] = () => undefined,
  diagnose: (diagnostic: CompactorDiagnostic) => void = () => {}, retryDelays: readonly number[] = [1000, 2000],
  incidentContext: () => IncidentContext = () => ({})): Compressor {
  const gate = primeFirst();
  const shared = typeof sharedOrRetries === 'function' ? sharedOrRetries : () => undefined;
  const retries = typeof sharedOrRetries === 'function' ? retryDelays : sharedOrRetries;
  return async (input, signal) => {
    const incidentId = createCompactorIncidentId();
    const { sessionId, recoveryIncidentId } = incidentContext();
    const selected = choice(), resolved = resolveModel(registry, selected);
    if (!resolved) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}. Use /optchat model.`);
    const model = resolved.model, thinking = reasoningFor(model, selected.thinking);
    const sourceBytes = bytes(input.source), limit = Math.min(accepted(), sourceBytes - 1);
    const target = Math.floor(Math.min(NODE, limit) * 7 / 8);
    const step = `${input.historical ? IMPORT_GUIDANCE + '\n\n' : ''}${task(input, target)}`;
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: input.context }, { type: 'text', text: `\n\n${step}` }], timestamp: Date.now() }];
    const view = splitView(input.context);
    const prefix = model.api === 'anthropic-messages' && view.length > 1 ? `${model.provider}/${model.id}/${thinking ?? 'off'}\n${view.slice(0, -1).join('')}` : undefined;
    const base = shared() ?? { systemPrompt: PROMPT };
    let request = 0, failures = 0, attempts = 0, summaries = 0;
    let shortest: string | undefined;
    const ask = async (): Promise<AssistantMessage> => {
      for (;;) {
        signal.throwIfAborted();
        const context: AgentMessage[] = [{ role: 'system', content: base.systemPrompt, toolsAdded: base.tools, timestamp: 0 }, ...messages];
        assertContextFits(context, model.contextWindow, model.maxTokens);
        const warmed = prefix ? await gate(prefix, signal) : () => {};
        const trace = new CompactorTrace(input, model, selected.thinking, thinking, ++request, base.tools?.length ?? 0, incidentId);
        Object.assign(trace.diagnostic, { sessionId, recoveryIncidentId });
        let reply: AssistantMessage | undefined, failure: unknown;
        let responded = false;
        try {
          const stream = registry.streamSimple(model, { ...base, messages }, {
            sessionId: 'optchat-compactor', transport: 'sse', reasoning: thinking, signal, cacheRetention: 'short', toolChoice: 'none',
            onPayload: payload => { const cached = model.api === 'anthropic-messages' ? cachePayload(payload) : payload; trace.payload(cached); return cached; },
            onResponse: response => trace.response(response),
            onProviderStreamEvent: event => trace.native(event),
          });
          for await (const event of stream) {
            trace.event(event);
            if (!responded) {
              responded = true;
              warmed(event.type !== 'error');
            }
          }
          reply = await stream.result();
          trace.result(reply);
          if (reply.stopReason === 'error') markPolicyRefusal(trace, reply);
          const diagnostic = trace.diagnostic;
          onUsage(reply, { incidentId: diagnostic.incidentId, attempt: diagnostic.attempt, outcome: usageOutcome(diagnostic.outcome),
            failed: diagnostic.failed, errorCategory: diagnostic.errorCategory,
            recoveryIncidentId: diagnostic.recoveryIncidentId });
        } catch (error) {
          failure = error;
          trace.failure(error);
          markPolicyRefusal(trace, error);
        } finally {
          if (!responded) warmed(false);
          diagnose(trace.finish(signal));
        }
        const retryError = failure ?? (reply?.stopReason === 'error' ? reply : undefined);
        if (retryError !== undefined) {
          if (isPolicyRefusal(retryError)) throw policyRefusalError();
          signal.throwIfAborted();
          if (retryable(retryError, trace, failures, retries, signal)) {
            await sleep(retries[failures++], undefined, { signal });
            continue;
          }
          const detail = `${model.provider}/${model.id}`;
          throw compactorError(failure ?? new Error(reply?.errorMessage ?? 'Compactor error'), detail);
        }
        if (!reply) throw new Error('Compactor produced no response.');
        return reply;
      }
    };
    while (attempts < 5) {
      attempts++;
      const reply = await ask();
      const detail = `${model.provider}/${model.id}, ${thinking ?? 'off'}, stop=${reply.stopReason}`;
      if (reply.stopReason === 'length' || reply.content.some(block => block.type === 'toolCall')) continue;
      const line = summaryText(reply, detail);
      summaries++;
      const size = bytes(line);
      if (size <= limit) return line;
      if (size < sourceBytes && (shortest === undefined || size < bytes(shortest))) shortest = line;
      messages.push(reply);
      const cut = Buffer.from(line).subarray(0, limit).toString('utf8').replace(/\uFFFD$/, '');
      messages.push({ role: 'user', content: tooLong(size, cut, limit, sourceBytes), timestamp: Date.now() });
    }
    // The byte target guides retries, not a second failure cliff. Keep the shortest
    // complete shrinking reply; persisted nodes and views account for actual bytes.
    if (shortest !== undefined) return shortest;
    if (!summaries) throw new Error('Compactor returned no whole line in 5 tries.');
    throw new Error(`Compactor returned no acceptable summary in ${attempts} attempts (limit ${limit} bytes; source ${sourceBytes} bytes; shortest ${shortest === undefined ? 'none' : bytes(shortest)}; it must be smaller than the source).`);
  };
}
