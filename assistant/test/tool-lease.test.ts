import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { snapshotDatabase } from '../src/ops/backup.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../src/store/db.ts';
import { WorkerRuntime } from '../src/runtime/worker.ts';
import { ToolEffects } from '../src/runtime/tool-effects.ts';
import { ToolTask } from '../src/runtime/tool-task.ts';
import { queuedTask } from './task-fixtures.ts';

test('lease steal fences admission and stale projection without replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-lease-')); const path = join(dir, 'tasks.sqlite');
  const store = new TaskStore(path, 'p'); let now = 1000; let calls = 0; let defer = false; let release!: () => void;
  const event = (id: string) => ({ version: 1 as const, eventId: id, correlationId: id, profileId: 'p', taskId: 't', sessionId: 's', channelId: 'c', runId: 'r', source: { actorId: 'human', sourceKind: 'trusted-local-human' as const, sourceEventId: id }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), evidence: { kind: 'observed' as const, reference: 'test' } });
  store.create(queuedTask('p', 't', 'preview', 'create'), event('create')); store.transition('t', 1, 'working', event('working'));
  const a = new WorkerRuntime({ databasePath: path, owner: 'a', now: () => now, leaseMs: 1000 });
  const b = new WorkerRuntime({ databasePath: path, owner: 'b', now: () => now, leaseMs: 1000 });
  const effects = new ToolEffects(path, { prepare: () => ({ decision: 'review', reviewId: 'review' }), status: () => 'absent', ready: () => true, dispatch: async () => { calls++; if (defer) await new Promise<void>(resolve => { release = resolve; }); return 'preview'; } }, (id, revision) => store.get(id)?.revision === revision);
  const task = new ToolTask(store, effects, 'p', 'c');
  const request = (operationId: string) => ({ version: 1 as const, operationId, profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'computer', action: 'browser_text', account: 'a', destination: 'd', policyVersion: 'v', expiresAt: Date.now() + 60000, payload: Buffer.from('x') });
  try {
    assert.equal(await a.acquire(), true); const old = a.leaseIdentity();
    const first = task.prepare(request('first'), 2); now += 1001; assert.equal(await b.acquire(), true);
    await assert.rejects(task.resume(first.id, old), /lease_lost/); assert.equal(calls, 0);
    defer = true; const active = task.resume(first.id, b.leaseIdentity()); assert.equal(calls, 1);
    now += 1001; assert.equal(await a.acquire(), true);
    await assert.rejects(task.resume(first.id, a.leaseIdentity()), /tool_stale/); assert.equal(calls, 1);
    release(); await assert.rejects(active, /lease_lost/);
    assert.equal(store.get('t')!.status, 'working'); assert.equal(effects.get(first.id).state, 'done');
    await task.resume(first.id, a.leaseIdentity()); assert.equal(store.get('t')!.status, 'ready_for_review'); assert.equal(calls, 1);
    const copy = join(dir, 'copy.sqlite'); writeFileSync(copy, snapshotDatabase(path).image);
    const copied = new TaskStore(copy, 'p');
    try { assert.throws(() => new ToolTask(copied, effects, 'p', 'c'), /tool_database_mismatch/); } finally { copied.close(); }
    const other = new TaskStore(join(dir, 'other.sqlite'), 'p');
    try {
      const otherEvent = (id: string) => ({ ...event(id), sequence: other.nextSequence() });
      other.create(queuedTask('p', 't', 'preview', 'create'), otherEvent('create'));
      other.transition('t', 1, 'working', otherEvent('working'));
      assert.equal(other.get('t')!.revision, 2);
      assert.throws(() => new ToolTask(other, effects, 'p', 'c'), /tool_database_mismatch/);
    } finally { other.close(); }
  } finally { await a.stop(); await b.stop(); a.close(); b.close(); effects.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
