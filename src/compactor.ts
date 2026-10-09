import { clampThinkingLevel, type Api, type AssistantMessage, type Message, type Model, type Tool } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { accountGroup } from './profiles.ts';
import { PROMPT } from './recipe-prompt.ts';
import { bytes, NODE, start, type Compressor, type Part } from './memory.ts';
import { cachePayload, splitView } from './cache.ts';
import { IMPORT_GUIDANCE } from './import/guidance.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { CompactorTrace, type CompactorDiagnostic } from './compactor-diagnostics.ts';

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
/** The recipe's compaction task, verbatim. */
export function task({ source, part, result }: { source: string; part: Part; result?: string }) {
  if (!part.l) {
    // Cheap models summarized a message together with the <chat> lines before it, under their kind: the task names both.
    const kind = /^(\w+): /.exec(source)?.[1];
    return `Compaction: compress message ${part.i}${kind ? `, kind ${kind},` : ''} into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${RULER}\n`
      + `Summarize <input> alone${kind ? `, starting with "${kind}:"` : ''}: the <chat> lines are other messages, never copy them in.\n<input>\n${source}\n</input>`
      + (result === undefined ? '' : `\nThe call's result is in <result>: say in a few words what it found or did.\n<result>\n${result}\n</result>`);
  }
  const a = { l: part.l - 1, i: 2 * part.i }, b = { l: part.l - 1, i: 2 * part.i + 1 };
  return `Compaction: merge lines ${label(a)} and ${label(b)}, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${RULER}\n`
    + `<chat> may hold their messages, ${start(part)} to ${start(part) + 2 ** part.l - 1}, in more detail: take details\nof them from there too.\n<input>\n${source}\n</input>`;
}
const WARM_MS = 4 * 60_000; // Anthropic's short cache lives 5 minutes from its last use.

/** Parallel calls can't read a cache entry that isn't written yet, so one call primes a cold prefix and the rest wait until its response starts (recipe §3.3).
 * Parallel compactions end their views at different messages, so a call also waits for a primer of a shorter prefix of its own view. */
function primeFirst() {
  const warm = new Map<string, number | Promise<void>>();
  return async (prefix: string, signal: AbortSignal) => {
    const priming = () => { for (const [k, state] of warm) if (typeof state !== 'number' && prefix.startsWith(k)) return state; };
    for (let state = warm.get(prefix) ?? priming(); state !== undefined; state = warm.get(prefix) ?? priming()) {
      if (typeof state === 'number') { if (Date.now() - state < WARM_MS) break; warm.delete(prefix); continue; }
      // A cancelled waiter leaves at once instead of waiting for someone else's primer.
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
/** What a compaction shares with the turns (recipe §4): the same system prompt and tools, never called. */
export interface Shared { systemPrompt: string; tools?: Tool[] }
function summaryText(reply: AssistantMessage, detail: string) {
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Compactor ${reply.stopReason} (${detail})`);
  if (reply.stopReason === 'length') throw new Error(`Compactor response truncated (${detail}).`);
  if (reply.content.some(block => block.type === 'toolCall')) throw new Error(`Compactor returned a tool call instead of a summary (${detail}).`);
  // A line can copy its id+n| head from the view.
  const line = reply.content.filter(block => block.type === 'text').map(block => block.text).join('').trim().replace(/^\d+\+\d+\|\s*/, '');
  if (!line) throw new Error(`Compactor returned no text (${detail}; blocks=${reply.content.map(block => block.type).join(',') || 'none'}). See compactor-diagnostics.jsonl.`);
  return line;
}
/** The model is asked for 512 bytes; `accepted` is the longest line kept without a retry (the profile's summary size tolerance).
 * `shared` is the turns' prompt and tools once a turn has built them; until then, the recipe's prompt alone. */
export function createCompressor(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {}, accepted = () => DEFAULT_SETTINGS.summaryAcceptBytes, shared: () => Shared | undefined = () => undefined,
  diagnose: (diagnostic: CompactorDiagnostic) => void = () => {}): Compressor {
  const gate = primeFirst();
  return async (input, signal) => {
    const selected = choice();
    const resolved = resolveModel(registry, selected);
    if (!resolved) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}. Use /optchat model.`);
    const model = resolved.model;
    const thinking = reasoningFor(model, selected.thinking);
    const step = `${input.historical ? IMPORT_GUIDANCE + '\n\n' : ''}${task(input)}`;
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: input.context }, { type: 'text', text: `\n\n${step}` }], timestamp: Date.now() }];
    const view = splitView(input.context);
    const prefix = model.api === 'anthropic-messages' && view.length > 1 ? `${model.provider}/${model.id}/${thinking ?? 'off'}\n${view.slice(0, -1).join('')}` : undefined;
    const base = shared() ?? { systemPrompt: PROMPT };
    const tries: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const warmed = prefix ? await gate(prefix, signal) : () => {};
      let reply: AssistantMessage;
      const trace = new CompactorTrace(input, model, selected.thinking, thinking, attempt + 1, base.tools?.length ?? 0);
      try {
        const stream = registry.streamSimple(model, { ...base, messages }, {
          // A shared session id is the OpenAI prompt-cache key; SSE because over a websocket Codex would chain unrelated parallel calls on one cached connection.
          sessionId: 'optchat-compactor', transport: 'sse',
          reasoning: thinking, signal, cacheRetention: 'short', toolChoice: 'none',
          onPayload: payload => {
            const cached = model.api === 'anthropic-messages' ? cachePayload(payload) : payload;
            trace.payload(cached); return cached;
          },
          onResponse: response => trace.response(response),
          onProviderStreamEvent: event => trace.native(event),
        });
        // The cache entry is usable once the response starts: Pi emits 'start' when the response headers arrive, 'error' if the request failed.
        for await (const event of stream) { trace.event(event); warmed(event.type !== 'error'); }
        reply = await stream.result();
        trace.result(reply);
      } catch (error) { trace.failure(error); throw error; }
      finally { warmed(false); diagnose(trace.finish()); }
      onUsage(reply);
      const detail = `${model.provider}/${model.id}, ${thinking ?? 'off'}, stop=${reply.stopReason}, raw=${trace.diagnostic.rawStopReason ?? 'unknown'}`;
      const line = summaryText(reply, detail);
      tries.push(line);
      // A merge of two short lines can come back nearly as big as both, so a line must also shrink what it replaces.
      if (bytes(line) <= accepted() && bytes(line) < bytes(input.source)) break;
      messages.push(reply);
      const cut = Buffer.from(line).subarray(0, NODE).toString('utf8').replace(/\uFFFD$/, '');
      messages.push({ role: 'user', content: `Too long: your line is ${bytes(line)} bytes, over the 512-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${cut}| ← LIMIT`, timestamp: Date.now() });
    }
    return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
  };
}
