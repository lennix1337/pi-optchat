import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../src/store/db.ts';
import { WorkerRuntime } from '../src/runtime/worker.ts';
import { ToolEffects } from '../src/runtime/tool-effects.ts';
import { ToolTask } from '../src/runtime/tool-task.ts';
import { TaskExecutor } from '../src/runtime/task-executor.ts';
import { queuedTask } from './task-fixtures.ts';

test('tools executor cannot start or fail task after lease is stolen during readiness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-ready-')); const path = join(dir, 'tasks.sqlite'); const store = new TaskStore(path, 'p'); let now = 1000; let release!: (ready: boolean) => void;
  const source = { version: 1 as const, eventId: 'create', correlationId: 'create', profileId: 'p', taskId: 't', sessionId: 's', channelId: 'c', runId: 'r', source: { actorId: 'human', sourceKind: 'trusted-local-human' as const, sourceEventId: 'create' }, observedAt: new Date().toISOString(), sequence: 1, evidence: { kind: 'observed' as const, reference: 'test' } };
  store.create(queuedTask('p', 't', 'x', 'create'), source);
  const effects = new ToolEffects(path, { prepare: () => ({ decision: 'review', reviewId: 'r' }), status: () => 'absent', ready: () => false, dispatch: async () => null }, () => true);
  const task = new ToolTask(store, effects, 'p', 'c');
  const executor = new TaskExecutor({ store, profileId: 'p', databasePath: path, channels: ['c'], now: () => now, run: async () => ({ kind: 'draft', text: 'x' }), ready: () => new Promise(resolve => { release = resolve; }), tools: { task, request: () => { throw new Error('unexpected'); } } });
  const other = new WorkerRuntime({ databasePath: path, owner: 'other', now: () => now, leaseMs: 1000 });
  try {
    const running = executor.tick(); await new Promise(resolve => setImmediate(resolve));
    now += 46000; assert.equal(await other.acquire(), true); release(true);
    await assert.rejects(running, /lease_lost/); assert.equal(store.get('t')!.status, 'queued');
  } finally { await executor.close(); await other.stop(); other.close(); effects.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
