import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { emptyUsage } from '../src/usage.ts';

/** Registers offline provider `provider` (default `fixture`)/model `fixture`; `reply` sees each request and returns its text, or an Error for a failed response. */
export function registerFixtureModel(runtime: ModelRuntime, reply: (context: Context) => string | Error, contextWindow = 100000, provider = 'fixture'): void {
  runtime.registerProvider(provider, {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 1000 }],
    streamSimple(model, context) {
      const result = reply(context);
      const failed = result instanceof Error;
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: failed ? '' : result }], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: failed ? 'error' : 'stop', usage: emptyUsage(), ...(failed ? { errorMessage: result.message } : {}) };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push(failed ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: 'stop', message });
        stream.end();
      });
      return stream;
    },
  });
}
