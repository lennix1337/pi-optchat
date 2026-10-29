import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/store/db.ts';
import { TaskExecutor, WAIT, type DraftRunner } from '../src/runtime/task-executor.ts';
import { WorkerRuntime } from '../src/runtime/worker.ts';
import { createBackup, restoreBackup } from '../src/ops/backup.ts';
import type { Event } from '../src/contracts/events.ts';
import { queuedTask } from './task-fixtures.ts';
import { memoryProtector, privateDir } from './vault-support.ts';

const PROFILE = 'restore-executor';
const CHANNEL = 'Pessoal';
const event = (store: TaskStore, taskId: string, sourceEventId = randomUUID()): Event => ({ version: 1, eventId: randomUUID(), correlationId: randomUUID(), profileId: PROFILE, taskId,
  sessionId: 's', channelId: CHANNEL, runId: 'r', source: { actorId: 'operator', sourceKind: 'trusted-local-human', sourceEventId }, observedAt: new Date().toISOString(),
  sequence: store.nextSequence(), evidence: { kind: 'observed', reference: 'test' } });
const create = (store: TaskStore, id: string) => store.create(queuedTask(PROFILE, id, `Tarefa ${id}`, `create-${id}`), event(store, id, `create-${id}`));
const open = (store: TaskStore, dir: string, run: DraftRunner) => new TaskExecutor({ store, profileId: PROFILE, databasePath: join(dir, 'executor.sqlite'), channels: [CHANNEL], run });

test('restore holds queued, started-before-enqueue and completed-wait revisions: the restored executor generates nothing', () => privateDir('executor-restore-', async root => {
  const data = join(root, 'data'), restored = join(root, 'restored'), out = join(root, 'snapshot.backup'); mkdirSync(data, { mode: 0o700 }); mkdirSync(restored, { mode: 0o700 });
  const { protector } = memoryProtector();
  const store = new TaskStore(join(data, 'tasks.sqlite'), PROFILE);
  let original = 0, replayed = 0;
  try {
    // A wait job is done but its next attempt was not created yet.
    create(store, 'waited');
    const waiting = open(store, data, async () => WAIT);
    try { await waiting.tick(); } finally { await waiting.close(); }
    assert.equal(store.get('waited')!.status, 'working');
    // Queued before its first job, and working after the transition but before the enqueue.
    create(store, 'queued'); create(store, 'started');
    store.transition('started', 1, 'working', event(store, 'started'));
    await createBackup({ databasePath: join(data, 'tasks.sqlite'), profileId: PROFILE, out, protector });
    const live = open(store, data, async () => { original++; return { kind: 'draft', text: 'gerado depois do backup' }; });
    try { for (let pass = 0; pass < 4; pass++) await live.tick(); } finally { await live.close(); }
    assert.equal(original, 3, 'the original generates every task after the snapshot');
  } finally { store.close(); }

  const report = await restoreBackup({ backup: out, into: restored, profileId: PROFILE, protector });
  const copy = new TaskStore(join(restored, 'tasks.sqlite'), PROFILE);
  const executor = open(copy, restored, async () => { replayed++; return { kind: 'draft', text: 'repetido' }; });
  try {
    for (let pass = 0; pass < 4; pass++) await executor.tick();
    assert.equal(replayed, 0, 'restored executor must not generate held revisions');
    assert.equal(report.fenced.tasks, 3, 'every in-flight task revision is held');
    assert.deepEqual(['queued', 'started', 'waited'].map(id => [copy.get(id)!.status, copy.get(id)!.revision]), [['queued', 1], ['working', 2], ['working', 2]]);
    const jobs = new WorkerRuntime({ databasePath: join(restored, 'executor.sqlite'), owner: 'observe' });
    try { assert.deepEqual(jobs.jobs().map(job => [job.id, job.state]), [['draft:waited:2', 'done']], 'no job is created for a held revision'); } finally { jobs.close(); }
  } finally { await executor.close(); copy.close(); }
}));

test('held revisions are listed read-only, reconciled only by the operator, and a requeue is a new unheld revision', () => privateDir('executor-reconcile-', async root => {
  const data = join(root, 'data'), restored = join(root, 'restored'), out = join(root, 'snapshot.backup'); mkdirSync(data, { mode: 0o700 }); mkdirSync(restored, { mode: 0o700 });
  const { protector } = memoryProtector();
  const store = new TaskStore(join(data, 'tasks.sqlite'), PROFILE);
  try {
    create(store, 'queued'); create(store, 'started'); store.transition('started', 1, 'working', event(store, 'started'));
    create(store, 'done'); store.transition('done', 1, 'working', event(store, 'done')); store.transition('done', 2, 'ready_for_review', event(store, 'done'));
    await createBackup({ databasePath: join(data, 'tasks.sqlite'), profileId: PROFILE, out, protector });
  } finally { store.close(); }
  await restoreBackup({ backup: out, into: restored, profileId: PROFILE, protector });
  const copy = new TaskStore(join(restored, 'tasks.sqlite'), PROFILE);
  let generated = 0;
  const executor = open(copy, restored, async () => { generated++; return { kind: 'draft', text: 'novo' }; });
  const note = (sequence: number, text: string): Event => ({ ...event(copy, 'x'), sequence, evidence: { kind: 'observed', reference: text } });
  const reconcile = (taskId: string, revision: number) => copy.reconcileRestored(taskId, revision, (sequence, text) => ({ ...note(sequence, text), taskId }));
  try {
    await executor.tick();
    assert.deepEqual(copy.restoreHolds().map(hold => [hold.taskId, hold.revision, hold.status]), [['queued', 1, 'queued'], ['started', 2, 'working']], 'only in-flight revisions are listed; a task awaiting review is not');
    assert.deepEqual(['queued', 'started'].map(id => copy.get(id)!.status), ['queued', 'working'], 'listing requeues nothing');
    assert.equal(generated, 0);
    assert.throws(() => reconcile('queued', 2), /not held/);
    assert.throws(() => reconcile('done', 3), /not held/);
    assert.equal(reconcile('queued', 1).status, 'failed');
    assert.equal(reconcile('started', 2).status, 'failed');
    assert.deepEqual(copy.restoreHolds(), []);
    await executor.tick(); assert.equal(generated, 0, 'reconciling runs nothing');
    copy.transition('queued', copy.get('queued')!.revision, 'queued', event(copy, 'queued'));
    for (let pass = 0; pass < 3; pass++) await executor.tick();
    assert.equal(generated, 1, 'a requeued task is a new revision and generates once');
    assert.equal(copy.get('queued')!.status, 'ready_for_review');
  } finally { await executor.close(); copy.close(); }
}));
