import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { TaskStore } from '../src/store/db.ts';
import { WorkerRuntime } from '../src/runtime/worker.ts';
import { ToolEffects } from '../src/runtime/tool-effects.ts';
import { ToolTask } from '../src/runtime/tool-task.ts';
import { TaskExecutor } from '../src/runtime/task-executor.ts';
import { queuedTask } from './task-fixtures.ts';

test('killed claimed dispatcher stays read-only unresolved without replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-crash-')), db = join(dir, 'tasks.sqlite'); const store = new TaskStore(db, 'p'); let calls = 0;
  const event = (id: string) => ({ version: 1 as const, eventId: id, correlationId: id, profileId: 'p', taskId: 't', sessionId: 's', channelId: 'c', runId: 'r', source: { actorId: 'human', sourceKind: 'trusted-local-human' as const, sourceEventId: id }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), evidence: { kind: 'observed' as const, reference: 'test' } });
  store.create(queuedTask('p', 't', 'x', 'create'), event('create')); store.transition('t', 1, 'working', event('working'));
  const worker = new WorkerRuntime({ databasePath: db, owner: 'owner' }); await worker.acquire();
  const port = { prepare: () => ({ decision: 'review' as const, reviewId: 'r' }), status: () => 'absent' as const, ready: () => true, dispatch: async () => { calls++; return 'bad'; } };
  let effects = new ToolEffects(db, port, () => true);
  const request = { version: 1 as const, operationId: 'o', profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'computer', action: 'browser_text', account: 'a', destination: 'd', policyVersion: 'v', expiresAt: Date.now() + 60000, payload: Buffer.from('x') };
  const pending = effects.prepare(request, 2); effects.close();
  const child = spawn(process.execPath, [join(process.cwd(), 'assistant/test/tool-dispatch-child.mjs'), db, pending.id], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [chunk] = await once(child.stdout!, 'data'); assert.match(String(chunk), /CLAIMED/);
    assert.equal(child.kill(), true); const [exitCode, signal] = await once(child, 'exit');
    assert.ok(signal || exitCode !== 0, 'fixture was terminated after claim');
    effects = new ToolEffects(db, port, () => true); const task = new ToolTask(store, effects, 'p', 'c');
    const executor = new TaskExecutor({ store, profileId: 'p', databasePath: db, channels: ['c'], run: async () => ({ kind: 'draft', text: 'x' }), tools: { task, request: () => request } });
    try {
      assert.deepEqual(executor.unresolvedDispatches(), [{ taskId: 't', revision: 2, effectId: pending.id }]);
      assert.deepEqual(executor.unresolvedDispatches(), [{ taskId: 't', revision: 2, effectId: pending.id }]);
      await assert.rejects(effects.resume(pending.id, worker.leaseIdentity()), /tool_stale/); assert.equal(calls, 0);
    } finally { await executor.close(); effects.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await worker.stop(); worker.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
