import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSupportedThinkingLevels, type Model, type Api } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { agentModel } from '../src/agent-model.ts';
import { runContextBenchmark } from './context-benchmark.ts';
import { focusedChildView } from '../src/child-context.ts';
import { PerformanceMetrics, registerPerformance } from '../src/performance.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

test('sanitized log fixtures retain required evidence with fewer estimated tokens and bounded local cost', () => {
  const results = runContextBenchmark();
  assert.equal(results.length, 3);
  assert.ok(results.every(row => row.savedVsPreviousPercent > 50 && row.extraReads === 0));
  assert.ok(results.every(row => row.zoomDescriptionBytes < row.previousZoomDescriptionBytes));
});

test('agent labels use persisted identifiers and SDK thinking levels verbatim', () => {
  const model: Model<Api> = { id: 'synthetic-reasoner', name: 'Synthetic', provider: 'test', api: 'openai-responses', baseUrl: 'https://invalid.local', reasoning: true,
    input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  assert.ok(getSupportedThinkingLevels(model).length);
  for (const level of getSupportedThinkingLevels(model)) {
    assert.equal(agentModel({ model: `${model.provider}/${model.id}`, thinking: level }), `${model.id}(${level})`);
  }
  assert.equal(agentModel({ model: 'openai-codex/gpt-6-luna', thinking: 'xhigh' }), 'gpt-6-luna(xhigh)');
  assert.equal(agentModel({ model: 'unknown', thinking: 'unknown' }), 'unknown(unknown)');
  assert.ok(!agentModel({ model: 'evil\x1b\nmodel', thinking: 'hi\x1bgh' }).includes('\x1b'));
});
test('focused child history preserves complete identifiers and newest lines without changing task/instructions', () => {
  const view = `<chat>\n${Array.from({ length: 100 }, (_, i) => `${i}+1|user: ${'context '.repeat(40)}`).join('\n')}\n</chat>`;
  const focused = focusedChildView(view, 2000);
  assert.ok(Buffer.byteLength(focused) <= 2000);
  assert.match(focused, /older lines omitted/); assert.match(focused, /99\+1/); assert.match(focused, /0\+1/);
  assert.ok(!focused.includes('50+1|'));
  for (const line of focused.split('\n').filter(line => /^\d+\+/.test(line))) assert.ok(view.includes(line));
  assert.equal(focusedChildView('<chat>\n0+1|small\n</chat>'), '<chat>\n0+1|small\n</chat>');
});
test('focused child history keeps the old broad summaries before the newest lines and drops the middle', () => {
  const coarse = Array.from({ length: 4 }, (_, i) => `${i * 1024}+1024|user: rule ${i} ${'x'.repeat(200)}`);
  const fine = Array.from({ length: 100 }, (_, i) => `${4096 + i}+1|tool: step ${i} ${'y'.repeat(200)}`);
  const view = `<chat>\n${[...coarse, ...fine].join('\n')}\n</chat>`;
  const focused = focusedChildView(view, 4000);
  assert.ok(Buffer.byteLength(focused) <= 4000);
  for (const line of coarse) assert.ok(focused.includes(line), 'every broad summary is kept');
  assert.ok(focused.includes(fine.at(-1)!), 'the newest line is kept');
  assert.ok(!focused.includes(fine[0]), 'the oldest fine line is left out');
  const kept = focused.split('\n').filter(line => /^\d+\+/.test(line));
  assert.deepEqual(kept, [...kept].sort((a, b) => parseInt(a) - parseInt(b)), 'lines stay in chat order');
});
test('telemetry is bounded, numeric-only and measures stable system/tool overhead separately', () => {
  const metrics = new PerformanceMetrics();
  const messages: AgentMessage[] = [{ role: 'system', content: 'SECRET', sections: { instructions: 'private', skills: 'catalogue' },
    toolsAdded: [{ name: 'read', description: 'read', parameters: { type: 'object' } }], timestamp: 0 }];
  metrics.context(messages); metrics.context(messages);
  for (let i = 0; i < 10000; i++) metrics.record('context', i % 10);
  metrics.record('tool', NaN); metrics.record('tool', -1);
  let snapshot = metrics.snapshot();
  assert.equal(snapshot.request.prefixChanges, 0);
  assert.ok(snapshot.request.toolSchemaBytes > 0); assert.equal(snapshot.request.instructionBytes, 7);
  assert.equal(snapshot.stages.context!.count, 10000); assert.equal(snapshot.stages.tool, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|private|catalogue/);
  metrics.context([{ role: 'system', content: 'changed', timestamp: 0 }]); snapshot = metrics.snapshot();
  assert.equal(snapshot.request.prefixChanges, 1);
  snapshot.stages.context!.count = 0; assert.equal(metrics.snapshot().stages.context!.count, 10000);
});
test('real registered timing boundaries record tools and provider phases without storing payloads', async () => {
  const handlers = new Map<string, Function[]>(), metrics = new PerformanceMetrics();
  registerPerformance({ on: (name: string, fn: Function) => { handlers.set(name, [...handlers.get(name) ?? [], fn]); } } as unknown as ExtensionAPI, () => metrics);
  const emit = async (name: string, event: unknown) => { for (const fn of handlers.get(name) ?? []) await fn(event); };
  await emit('tool_execution_start', { toolCallId: 'one', args: 'SECRET' });
  await emit('tool_execution_end', { toolCallId: 'one', result: 'SECRET' });
  await emit('before_provider_request', { payload: { secret: true } });
  await emit('after_provider_response', { status: 200 });
  await emit('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } });
  await emit('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'hello again' }] } });
  await emit('message_end', { message: { role: 'assistant' } });
  assert.equal(metrics.snapshot().stages.first_content!.count, 1);
  for (const stage of ['tool', 'provider_headers', 'response'] as const) assert.equal(metrics.snapshot().stages[stage]!.count, 1);
  assert.doesNotMatch(JSON.stringify(metrics.snapshot()), /SECRET|hello|secret/);
});
