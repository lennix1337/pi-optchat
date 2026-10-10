import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createCompressor } from '../src/compactor.ts';
import { CompactorTrace, writeCompactorDiagnostic, type CompactorDiagnostic } from '../src/compactor-diagnostics.ts';
import { emptyUsage } from '../src/usage.ts';

async function run(content: AssistantMessage['content'], stopReason: Exclude<AssistantMessage['stopReason'], 'pending'> = 'stop', failure?: { message: string; thrown?: boolean; cause?: unknown; abort?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-diag-'));
  const diagnostics: CompactorDiagnostic[] = [];
  let toolChoice: unknown, declared: unknown;
  const controller = new AbortController();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-codex-responses',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      toolChoice = options?.toolChoice; declared = context.messages.find(m => m.role === 'system');
      if (failure?.abort) controller.abort('SECRET ABORT REASON');
      if (failure?.thrown) throw new Error(failure.message, { cause: failure.cause });
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason, rawStopReason: 'completed', usage: emptyUsage(), errorMessage: stopReason === 'error' ? failure?.message ?? 'secret credential overloaded' : undefined };
      queueMicrotask(async () => {
        await options?.onPayload?.({ tools: ['synthetic'], tool_choice: toolChoice, instructions: 'SECRET INPUT' }, model);
        await options?.onResponse?.({ status: 200, headers: { 'x-request-id': 'req-123', authorization: 'SECRET AUTH' } }, model);
        await options?.onProviderStreamEvent?.({ type: 'response.completed', response: { status: 'completed', id: 'resp-123', output: [{ type: 'reasoning', summary: [{ text: 'SECRET REASONING' }] }, { type: 'message', content: [{ type: 'output_text', text: 'SECRET OUTPUT' }] }] } }, model);
        stream.push({ type: 'start', partial: message });
        if (stopReason === 'error' || stopReason === 'aborted') stream.push({ type: 'error', reason: stopReason, error: message });
        else stream.push({ type: 'done', reason: stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  const tools = [{ name: 'read', description: 'Read.', parameters: Type.Object({}) }];
  const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'fixture', model: 'fixture', thinking: 'high' }), undefined, undefined,
    () => ({ systemPrompt: 'shared SECRET SYSTEM', tools }), diagnostic => diagnostics.push(diagnostic));
  let line: string | undefined, error: unknown;
  try { line = await compress({ context: '<chat>SECRET HISTORY</chat>', source: 'user: SECRET INPUT ' + 'x'.repeat(600), part: { l: 1, i: 57 } }, controller.signal); }
  catch (caught) { error = caught; }
  finally { rmSync(dir, { recursive: true, force: true }); }
  return { line, error, diagnostics, toolChoice, declared };
}

test('a summary keeps the shared tools but disables calls, and logs metadata rather than content', async () => {
  const result = await run([{ type: 'text', text: 'talk: SECRET OUTPUT' }]);
  assert.equal(result.toolChoice, 'none');
  assert.match(JSON.stringify(result.declared), /read/);
  assert.equal(result.line, 'talk: SECRET OUTPUT');
  assert.equal(result.diagnostics.length, 1);
  const diagnostic = result.diagnostics[0];
  assert.equal(diagnostic.node, '114+2');
  assert.equal(diagnostic.httpStatus, 200);
  assert.equal(diagnostic.toolChoice, 'none');
  assert.ok(diagnostic.requestBytes! > 0);
  assert.equal(diagnostic.requestId, 'req-123');
  assert.equal(diagnostic.nativeStatus, 'completed');
  assert.equal(diagnostic.outcome, 'text');
  assert.deepEqual(diagnostic.nativeOutputTypes, ['reasoning', 'message']);
  assert.equal(diagnostic.responseId, 'resp-123');
  assert.deepEqual(diagnostic.nativeContentTypes, ['output_text']);
  assert.equal(diagnostic.nativeTextBytes, Buffer.byteLength('SECRET OUTPUT'));
  assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|credential|authorization/);
});

test('empty, tool-only, truncated and provider-error replies have distinct diagnostics and are never saved as summaries', async () => {
  const cases: [AssistantMessage['content'], Exclude<AssistantMessage['stopReason'], 'pending'>, string][] = [
    [[], 'stop', 'empty'],
    [[{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'SECRET FILE' } }], 'toolUse', 'tool_call'],
    [[{ type: 'text', text: 'truncated SECRET OUTPUT' }], 'length', 'length'],
    [[], 'error', 'error'],
    [[], 'aborted', 'aborted'],
  ];
  for (const [content, stop, outcome] of cases) {
    const result = await run(content, stop);
    assert.ok(result.error, outcome);
    assert.equal(result.line, undefined);
    assert.equal(result.diagnostics[0].outcome, outcome);
    assert.equal(result.diagnostics[0].events.start, 1);
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /SECRET|credential/);
  }
});

test('interrupted streams are identified without saving partial text or adding immediate retries', async () => {
  for (const message of ['terminated', 'Codex stream ended without a stop reason', 'read ECONNRESET', 'UND_ERR_SOCKET']) {
    for (const thrown of [false, true]) {
      const result = await run([{ type: 'text', text: 'partial SECRET OUTPUT' }], 'error', { message, thrown });
      assert.match(String(result.error), /stream interrupted before a usable summary/);
      assert.match(String(result.error), /fixture\/fixture/);
      assert.match(String(result.error), /original messages are retained/i);
      assert.equal(result.line, undefined);
      assert.equal(result.diagnostics.length, 1, 'no immediate provider retry');
      assert.equal(result.diagnostics[0].errorCategory, 'stream_interrupted');
      assert.doesNotMatch(JSON.stringify(result.diagnostics), /SECRET|ECONNRESET|terminated/);
    }
  }
});

test('rate limits and cancellation are not mislabeled as interrupted streams', async () => {
  for (const [message, category] of [['429 rate_limit_error', 'rate_or_usage_limit'], ['operation aborted', 'cancelled'], ['request timeout', 'timeout']]) {
    const result = await run([], 'error', { message });
    assert.equal(result.diagnostics[0].errorCategory, category);
    assert.doesNotMatch(String(result.error), /stream interrupted/);
    assert.equal(result.line, undefined);
  }
});

test('transport diagnostics allowlist observable nested codes and record abort state and last-event timing', async () => {
  const model = { provider: 'fixture', id: 'fixture', api: 'openai-codex-responses' } as Model<Api>;
  const trace = new CompactorTrace({ context: '', source: '', part: { l: 1, i: 57 } }, model, 'high', 'high', 0, 0);
  const nested = new Error('SECRET ERROR', { cause: new Error('SECRET CAUSE', { cause: { code: 'ECONNRESET', address: 'SECRET HOST' } }) });
  trace.failure(nested);
  const reset = trace.finish(new AbortController().signal);
  assert.equal(reset.transportCode, 'ECONNRESET');
  assert.equal(reset.errorCategory, 'stream_interrupted');
  assert.equal(reset.aborted, false);
  assert.equal(reset.lastEventElapsedMs, undefined);
  assert.doesNotMatch(JSON.stringify(reset), /SECRET|address|cause/);

  // Pi's lazy stream converts provider setup exceptions to errorMessage, discarding their causes.
  const flattened = await run([], 'error', { message: 'SECRET ERROR', thrown: true, cause: nested });
  assert.equal(flattened.diagnostics[0].transportCode, undefined);
  assert.equal(flattened.diagnostics[0].errorCategory, 'other');
  assert.equal(flattened.diagnostics[0].events.error, 1);
  assert.doesNotMatch(JSON.stringify(flattened.diagnostics), /SECRET/);

  const unknown = await run([], 'error', { message: 'SECRET ERROR', thrown: true, cause: { code: 'SECRET_TOKEN' } });
  assert.equal(unknown.diagnostics[0].transportCode, undefined);
  assert.doesNotMatch(JSON.stringify(unknown.diagnostics), /SECRET/);

  const cancelled = await run([], 'aborted', { message: 'operation aborted', abort: true });
  assert.equal(cancelled.diagnostics[0].aborted, true);
  assert.ok(cancelled.diagnostics[0].lastEventElapsedMs! >= 0);
  assert.ok(cancelled.diagnostics[0].lastEventElapsedMs! <= cancelled.diagnostics[0].elapsedMs);
  assert.doesNotMatch(JSON.stringify(cancelled.diagnostics), /SECRET/);

  const timeout = new CompactorTrace({ context: '', source: '', part: { l: 1, i: 57 } }, model, 'high', 'high', 0, 0);
  timeout.failure(new Error('SECRET ERROR', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }));
  assert.equal(timeout.diagnostic.transportCode, 'UND_ERR_HEADERS_TIMEOUT');
  assert.equal(timeout.diagnostic.errorCategory, 'timeout');
  assert.doesNotMatch(JSON.stringify(timeout.diagnostic), /SECRET/);
});

test('diagnostic files rotate instead of growing without bound', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-diag-file-'));
  try {
    const diagnostic = (await run([])).diagnostics[0];
    writeFileSync(join(dir, 'compactor-diagnostics.jsonl'), 'x'.repeat(1_000_000));
    writeCompactorDiagnostic(dir, diagnostic);
    assert.equal(readFileSync(join(dir, 'compactor-diagnostics.jsonl.1'), 'utf8').length, 1_000_000);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'compactor-diagnostics.jsonl'), 'utf8')), diagnostic);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
