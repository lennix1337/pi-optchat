import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createCompressor } from '../src/compactor.ts';
import { writeCompactorDiagnostic, type CompactorDiagnostic } from '../src/compactor-diagnostics.ts';
import { emptyUsage } from '../src/usage.ts';

async function run(content: AssistantMessage['content'], stopReason: Exclude<AssistantMessage['stopReason'], 'pending'> = 'stop') {
  const dir = mkdtempSync(join(tmpdir(), 'oc-diag-'));
  const diagnostics: CompactorDiagnostic[] = [];
  let toolChoice: unknown, declared: unknown;
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-codex-responses',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      toolChoice = options?.toolChoice; declared = context.messages.find(m => m.role === 'system');
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason, rawStopReason: 'completed', usage: emptyUsage(), errorMessage: stopReason === 'error' ? 'secret credential overloaded' : undefined };
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
  try { line = await compress({ context: '<chat>SECRET HISTORY</chat>', source: 'user: SECRET INPUT ' + 'x'.repeat(600), part: { l: 1, i: 57 } }, new AbortController().signal); }
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
