import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor } from '../src/compactor.ts';
import { emptyUsage } from '../src/usage.ts';

const haiku = { id: 'claude-haiku-5-5', name: 'Haiku', reasoning: true, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const input = { context: '<chat>prior decision</chat>', source: 'user: original detail '.repeat(100), part: { l: 0, i: 0 } };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-account-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  const sent: string[] = [];
  const provider = (id: string) => runtime.registerProvider(id, {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-codex-responses', models: [haiku],
    streamSimple(model) {
      sent.push(model.provider);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'user: retained decision' }], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  return { registry: new ModelRegistry(runtime), provider, sent, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

// Reported 04/11: at a reload multi-account drops its numbered accounts and publishes them again in its own session_start,
// after OptChat had resumed two summaries, which then went to the base `anthropic` account (a key with no credit: 400).
test('a summary for a numbered account not published yet waits for it instead of running on the base account', async () => {
  const f = await fixture();
  try {
    f.provider('anthropic');
    const compress = createCompressor(f.registry, () => ({ provider: 'anthropic-account-2', model: 'claude-haiku-5-5', thinking: 'off' }));
    setTimeout(() => f.provider('anthropic-account-2'), 300);
    const summary = await compress(input, AbortSignal.timeout(5000));
    assert.match(summary, /retained decision/);
    assert.deepEqual(f.sent, ['anthropic-account-2'], 'the base account is never asked');
  } finally { f.clean(); }
});

test('a numbered account that never appears fails the summary without asking the base account', async () => {
  const f = await fixture();
  try {
    f.provider('anthropic');
    const compress = createCompressor(f.registry, () => ({ provider: 'anthropic-account-2', model: 'claude-haiku-5-5', thinking: 'off' }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600);
    await assert.rejects(compress(input, controller.signal));
    assert.deepEqual(f.sent, []);
  } finally { f.clean(); }
});
