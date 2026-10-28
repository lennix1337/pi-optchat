import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime/worker.ts';
import { lines, producer, runWorker, withDir } from './runtime-support.ts';

test('stable notification ids are acknowledged per channel and failures stay visible', () => withDir('runtime-outbox-', async dir => {
  const runtime = createRuntime({ databasePath: join(dir, 'runtime.db'), owner: 'a', maxAttempts: 2 });
  try {
    assert.equal(await runtime.acquire(), true);
    runtime.notify('task-1:done', ['tui', 'mail'], 'Task 1 finished');
    runtime.notify('task-1:done', ['tui', 'mail'], 'Task 1 finished');
    assert.throws(() => runtime.notify('task-1:done', ['tui'], 'changed'), /notification_conflict/);
    const tui: string[] = [];
    assert.deepEqual(await runtime.deliver('tui', note => { tui.push(note.id); }), { delivered: 1, failed: 0 });
    assert.deepEqual(await runtime.deliver('tui', note => { tui.push(note.id); }), { delivered: 0, failed: 0 }, 'acknowledged once per channel');
    assert.deepEqual(tui, ['task-1:done']);

    const refuse = () => { throw new Error('smtp said no to secret@example.test'); };
    assert.deepEqual(await runtime.deliver('mail', refuse), { delivered: 0, failed: 1 });
    let mail = runtime.notifications().find(n => n.channel === 'mail')!;
    assert.equal(mail.state, 'pending'); assert.equal(mail.error, 'delivery_failed'); assert.equal(mail.attempts, 1);
    await runtime.deliver('mail', refuse);
    mail = runtime.notifications().find(n => n.channel === 'mail')!;
    assert.equal(mail.state, 'failed', 'exhausted delivery stays visible instead of disappearing');
    assert.doesNotMatch(JSON.stringify(runtime.notifications()), /secret@example\.test/, 'diagnostics are minimized');
    assert.equal(runtime.notifications().find(n => n.channel === 'tui')!.state, 'delivered');
  } finally { runtime.close(); }
}));

test('a worker killed after sending but before acknowledging redelivers the same stable id', () => withDir('runtime-outbox-crash-', dir => {
  const front = producer(dir);
  try {
    front.notify('task-1:done', ['tui'], 'Task 1 finished');
    assert.notEqual(runWorker(dir, 'worker-a', 'sent'), 0);
    assert.equal(front.notifications()[0].state, 'pending');
    runWorker(dir, 'worker-b');
    assert.deepEqual(lines(dir, 'tui.log'), ['task-1:done', 'task-1:done'], 'at-least-once with the same id lets the channel deduplicate');
    assert.equal(front.notifications()[0].state, 'delivered');
  } finally { front.close(); }
}));
