import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { OperationJournal, registerOperationSafety } from '../src/operations.ts';
import { OutputContext } from '../src/output-context.ts';
import { OutputStore } from '../src/output-store.ts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { PerformanceMetrics, registerPerformance } from '../src/performance.ts';
import { tempDir } from './support.ts';

function temporary(t: { after(fn: () => void): void }) {
  const { dir, close } = tempDir('optchat-regression-');
  t.after(close);
  return dir;
}

test('durable receipts distinguish Pi dispatch from a response alone without permitting replay', async t => {
  const dir = temporary(t), journal = new OperationJournal(dir);
  const hooks = new Map<string, (...args: any[]) => any>();
  registerOperationSafety({ on: (name: string, fn: (...args: any[]) => any) => hooks.set(name, fn),
    getAllTools: () => [], registerTool() {} } as unknown as ExtensionAPI, () => journal);
  const ctx = { sessionManager: { getSessionId: () => 's', getLeafId: () => 'leaf' } };
  // Actual Pi 1.2 order: dispatch notification precedes argument validation/tool_call.
  hooks.get('tool_execution_start')!({ toolName: 'write', toolCallId: 'one' }, ctx);
  hooks.get('tool_call')!({ toolName: 'write', toolCallId: 'one', input: { secret: 'never-save-this' } }, ctx);
  const interrupted = new OperationJournal(dir);
  assert.equal(interrupted.pending()[0].dispatchObserved, true, 'dispatch metadata is durable before the response, without another write');
  assert.match(interrupted.blockReason('write')!, /uncertain/);
  hooks.get('tool_result')!({ toolName: 'write', toolCallId: 'one', isError: true }, ctx);
  const reopened = new OperationJournal(dir);
  const receipt = reopened.pending()[0] as any;
  assert.equal(receipt.dispatchObserved, true);
  assert.ok(receipt.startedAt > 0 && receipt.responseAt >= receipt.startedAt);
  assert.match(reopened.blockReason('write')!, /uncertain/);
  assert.doesNotMatch(readFileSync(join(dir, 'operations.json'), 'utf8'), /never-save-this/);
  reopened.resolve(receipt.id, 'Independent readback fixture: file state inspected');
  assert.equal(reopened.blockReason('write'), undefined);
});

test('missing dispatch evidence stays unknown and never clears an interrupted/error barrier', t => {
  const dir = temporary(t), journal = new OperationJournal(dir);
  journal.start('s', 'call', 'write', {});
  journal.finish('s', 'call', true);
  const receipt = new OperationJournal(dir).pending()[0];
  assert.equal(receipt.dispatchObserved, false);
  assert.equal(receipt.outcome, 'not_verified');
  assert.match(new OperationJournal(dir).blockReason('write')!, /uncertain/);
});

test('unhelpful large output is analyzed once per immutable message without altering its text', t => {
  const outputs = new OutputContext(new OutputStore(temporary(t), 'fixture'));
  const message = { role: 'toolResult', toolName: 'bash', toolCallId: 'x', content: [{ type: 'text', text: 'x'.repeat(16000) }],
    isError: false, timestamp: 1 } as AgentMessage;
  assert.equal(outputs.project([message])[0], message);
  assert.equal(outputs.project([message])[0], message);
  assert.equal((outputs.stats() as any).analyzed, 1);
});

test('actual provider payload telemetry is numeric only and never transforms payloads', async () => {
  const metrics = new PerformanceMetrics(), hooks = new Map<string, (...args: any[]) => any>();
  registerPerformance({ on: (name: string, fn: (...args: any[]) => any) => hooks.set(name, fn) } as unknown as ExtensionAPI, () => metrics);
  const payload = { system: 'private-instruction', messages: [{ content: 'secret-user-text' }], tools: [{ name: 'read', schema: {} }] };
  assert.equal(hooks.get('before_provider_request')!({ payload }), payload);
  assert.equal(metrics.snapshot().payload.calls, 0);
  metrics.measurePayload(true);
  assert.equal(hooks.get('before_provider_request')!({ payload }), payload);
  const snapshot = metrics.snapshot() as any;
  assert.equal(snapshot.payload.calls, 1);
  assert.equal(snapshot.payload.bytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.doesNotMatch(JSON.stringify(snapshot), /private-instruction|secret-user-text/);
  const circular: any = {}; circular.self = circular;
  assert.equal(hooks.get('before_provider_request')!({ payload: circular }), circular);
  assert.equal(metrics.snapshot().payload.measurementFailures, 1);
  metrics.measurePayload(false);
  hooks.get('before_provider_request')!({ payload });
  assert.equal(metrics.snapshot().payload.calls, 1);
});
