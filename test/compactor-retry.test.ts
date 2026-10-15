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
import { emptyUsage, type UsageAttribution } from '../src/usage.ts';

const refused = 'upstream connect error or disconnect/reset before headers. retried and the latest reset reason: remote connection failure, transport failure reason: delayed connect error: Connection refused';
async function fixture(errors: string[], abortOnFailure = false, successText = 'user: retained decision',
  incidentContext: () => { sessionId?: string; recoveryIncidentId?: string } = () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-retry-'));
  const controller = new AbortController();
  const diagnostics: CompactorDiagnostic[] = [];
  const usage: { message: AssistantMessage; attribution: UsageAttribution }[] = [];
  const requests: string[] = [], times: number[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-codex-responses',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const error = errors[requests.length];
      requests.push(JSON.stringify(context)); times.push(Date.now());
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: error ? 'partial text must not survive' : successText }], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: error ? 'error' : 'stop', usage: emptyUsage(), ...(error ? { errorMessage: error } : {}) };
      queueMicrotask(async () => {
        // This case models a failure after the response started; it must not be retried even though its text says "terminated".
        if (error === 'terminated') await options?.onResponse?.({ status: 200, headers: {} }, model);
        if (error) stream.push({ type: 'error', reason: 'error', error: message });
        else stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      });
      return stream;
    },
  });
  const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'fixture', model: 'fixture', thinking: 'medium' }),
    (message, attribution) => usage.push({ message, attribution }), undefined, undefined, diagnostic => {
    diagnostics.push(diagnostic);
    if (abortOnFailure && diagnostic.outcome === 'error') controller.abort();
  }, [1000, 2000], incidentContext);
  return { dir, controller, diagnostics, usage, requests, times, compress, clean: () => rmSync(dir, { recursive: true, force: true }) };
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

test('each response is attributed from its trace with one stable compressor incident ID', async () => {
  const f = await fixture(['503 service unavailable']);
  try {
    assert.equal(await f.compress(input, f.controller.signal), 'user: retained decision');
    assert.equal(f.requests.length, 2);
    const incidentId = f.diagnostics[0].incidentId;
    assert.ok(incidentId);
    assert.deepEqual(f.diagnostics.map(diagnostic => diagnostic.incidentId), [incidentId, incidentId]);
    assert.deepEqual(f.usage.map(({ attribution }) => [attribution.incidentId, attribution.attempt, attribution.outcome, attribution.failed, attribution.errorCategory]), [
      [incidentId, 1, 'error', true, 'unavailable'], [incidentId, 2, 'text', false, undefined],
    ]);
  } finally { f.clean(); }
});

test('a policy refusal is not retried and exposes only a safe terminal error code', async () => {
  const refusal = 'Request rejected due to a content policy violation (503 service unavailable)';
  const f = await fixture([refusal]);
  try {
    let caught: unknown;
    try { await f.compress(input, f.controller.signal); } catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal((caught as Error & { code?: string }).code, 'OPTCHAT_POLICY_REFUSAL');
    assert.equal(caught.message, 'Compactor request rejected by provider policy.');
    assert.doesNotMatch(JSON.stringify(caught), /content policy|503 service unavailable/);
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /content policy|503 service unavailable/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.usage[0]?.attribution.outcome, 'error');
    assert.equal(f.diagnostics[0]?.errorCategory, 'policy_refusal');
    assert.equal(f.usage[0]?.attribution.errorCategory, 'policy_refusal');
  } finally { f.clean(); }
});

test('a successful summary mentioning policy is not treated as a refusal', async () => {
  const f = await fixture([], false, 'The policy is to preserve the original decision.');
  try {
    assert.equal(await f.compress(input, f.controller.signal), 'The policy is to preserve the original decision.');
    assert.equal(f.requests.length, 1);
    assert.equal(f.diagnostics[0].outcome, 'text');
    assert.equal(f.diagnostics[0].failed, false);
  } finally { f.clean(); }
});

test('recovery correlation is snapshotted per invocation into diagnostics and usage attribution', async () => {
  let context = { sessionId: 'session-before', recoveryIncidentId: 'recovery-before' };
  const f = await fixture([], false, 'user: retained decision', () => context);
  try {
    const pending = f.compress(input, f.controller.signal);
    context = { sessionId: 'session-after', recoveryIncidentId: 'recovery-after' };
    assert.equal(await pending, 'user: retained decision');
    const diagnostic = f.diagnostics[0] as CompactorDiagnostic & { recoveryIncidentId?: string };
    const attribution = f.usage[0]?.attribution as (UsageAttribution & { recoveryIncidentId?: string }) | undefined;
    assert.equal(diagnostic.sessionId, 'session-before');
    assert.equal(diagnostic.recoveryIncidentId, 'recovery-before');
    assert.equal(attribution?.recoveryIncidentId, 'recovery-before');
  } finally { f.clean(); }
});
