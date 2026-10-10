import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor } from '../src/compactor.ts';
import { Memory } from '../src/memory.ts';
import type { CompactorDiagnostic } from '../src/compactor-diagnostics.ts';
import { emptyUsage } from '../src/usage.ts';

const refused = 'upstream connect error or disconnect/reset before headers. retried and the latest reset reason: remote connection failure, transport failure reason: delayed connect error: Connection refused';
async function fixture(errors: string[], abortOnFailure = false) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-retry-'));
  const controller = new AbortController();
  const diagnostics: CompactorDiagnostic[] = [];
  const requests: string[] = [], times: number[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-codex-responses',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const error = errors[requests.length];
      requests.push(JSON.stringify(context)); times.push(Date.now());
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: error ? 'partial text must not survive' : 'user: retained decision' }], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: error ? 'error' : 'stop', usage: emptyUsage(), ...(error ? { errorMessage: error } : {}) };
      queueMicrotask(() => {
        if (error) stream.push({ type: 'error', reason: 'error', error: message });
        else stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      });
      return stream;
    },
  });
  const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'fixture', model: 'fixture', thinking: 'medium' }), undefined, undefined, undefined, diagnostic => {
    diagnostics.push(diagnostic);
    if (abortOnFailure && diagnostic.outcome === 'error') controller.abort();
  });
  return { dir, controller, diagnostics, requests, times, compress, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
const input = { context: '<chat>prior decision</chat>', source: 'user: original detail '.repeat(100), part: { l: 0, i: 0 } };

test('the reported pre-header connection refusal retries the same input and publishes only the complete summary', async () => {
  const f = await fixture([refused]);
  const warnings: string[] = [];
  const memory = new Memory(f.dir, f.compress, warning => warnings.push(warning));
  try {
    memory.append('user', input.source);
    await memory.settle(AbortSignal.timeout(10000), 'tree');
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0], f.requests[1], 'retry must not add failed partial output to the prompt');
    assert.ok(f.times[1] - f.times[0] >= 1000, 'backoff precedes retry');
    assert.equal(memory.lastError, undefined);
    assert.deepEqual(warnings, [], 'recovered transient failures do not raise a persistent compactor warning');
    assert.equal(memory.zoom(0, 1), `0+1|user: ${input.source}`);
    assert.doesNotMatch(memory.render(), /partial text/);
    assert.deepEqual(f.diagnostics.map(d => d.outcome), ['error', 'text']);
    assert.deepEqual(f.diagnostics.map(d => d.attempt), [1, 2]);
    assert.equal(f.diagnostics[0].errorCategory, 'connection_failure');
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /original detail|partial text|Connection refused/);
  } finally { await memory.close(); f.clean(); }
});

test('persistent connection failure stops after three requests and preserves the original message', async () => {
  const f = await fixture([refused, refused, refused, refused]);
  const warnings: string[] = [];
  const memory = new Memory(f.dir, f.compress, warning => warnings.push(warning));
  try {
    memory.append('user', input.source);
    await memory.settle(AbortSignal.timeout(10000));
    assert.equal(f.requests.length, 3);
    assert.match(memory.lastError!, /Connection refused/);
    assert.equal(warnings.length, 1);
    assert.equal(memory.zoom(0, 1), `0+1|user: ${input.source}`);
    assert.doesNotMatch(memory.render(), /partial text/);
    assert.deepEqual(f.requests, Array(3).fill(f.requests[0]));
  } finally { await memory.close(); f.clean(); }
});

test('cancelling a retry backoff sends no second request', async () => {
  const f = await fixture([refused], true);
  try {
    await assert.rejects(f.compress(input, f.controller.signal), /abort/i);
    assert.equal(f.requests.length, 1);
  } finally { f.clean(); }
});

test('authentication, quota, aborted, unknown and post-response interrupted failures are not retried', async () => {
  for (const error of ['401 unauthorized', '429 rate_limit_error', 'operation aborted', 'unknown failure', 'terminated']) {
    const f = await fixture([error]);
    try {
      await assert.rejects(f.compress(input, f.controller.signal));
      assert.equal(f.requests.length, 1, error);
    } finally { f.clean(); }
  }
});

test('a pre-response 503 is retried with bounded backoff', async () => {
  const f = await fixture(['503 service unavailable']);
  try {
    assert.equal(await f.compress(input, f.controller.signal), 'user: retained decision');
    assert.equal(f.requests.length, 2);
  } finally { f.clean(); }
});
