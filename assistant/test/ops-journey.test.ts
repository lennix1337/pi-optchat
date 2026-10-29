import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime/worker.ts';
import { createNotificationCenter, type DeliveredNotification } from '../src/notifications/center.ts';
import { effect } from './runtime-support.ts';
import { CANARY, contains, privateDir } from './vault-support.ts';
import { PROFILE, TOKEN, api, createTaskBody, freePort, killRecordedService, runScript, serviceHome, writeConfig } from './ops-support.ts';

const workerChild = fileURLToPath(new URL('./ops-worker-child.ts', import.meta.url));
const operator = {};
const context = (id: string) => ({ sessionId: 'session', channelId: 'channel', runId: 'run', sourceEventId: id, evidenceReference: 'journey' });

function runWorker(dataDir: string, sink: string): void {
  const result = spawnSync(process.execPath, [workerChild, dataDir, sink], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}
const sent = (sink: string) => existsSync(sink) ? readFileSync(sink, 'utf8').split('\n').filter(Boolean) : [];
function enqueue(dataDir: string, id: string, text: string): void {
  const producer = createRuntime({ databasePath: join(dataDir, 'runtime.sqlite'), owner: 'producer' });
  try { producer.enqueue(id, 'effect', effect(`op-${id}`, text)); } finally { producer.close(); }
}

test('journey: disposable install -> task -> restart -> notification -> backup -> restore -> query, no external effect repeated', {
  skip: process.platform !== 'win32' && 'backups need the Windows DPAPI protector', timeout: 180_000,
}, () => privateDir('ops-journey-', async root => {
  const svc = serviceHome(root, await freePort());
  const restoredDir = join(root, 'restored'); mkdirSync(restoredDir, { mode: 0o700 });
  const restoredHome = serviceHome(root, await freePort(), 'restored-home');
  const sink = join(root, 'external-sink.log'), toasts: DeliveredNotification[] = [];
  const backup = join(root, 'journey.backup');
  try {
    // Install and start.
    assert.equal(runScript('start', ['--config', svc.config]).json.result, 'started');
    assert.equal(runScript('health', ['--config', svc.config]).json.state, 'healthy');

    // A task, and one external effect done by the worker.
    assert.equal((await api(svc.endpoint, '/v1/tasks', createTaskBody('task-1', `journey ${CANARY}`))).status, 200);
    enqueue(svc.data, 'send-a', 'mail A');
    runWorker(svc.data, sink);
    assert.deepEqual(sent(sink), ['mail A']);
    assert.equal((await api(svc.endpoint, '/v1/tasks/task-1/transition', { expectedRevision: 1, nextStatus: 'working', context: context('s-2') })).status, 200);
    assert.equal((await api(svc.endpoint, '/v1/tasks/task-1/transition', { expectedRevision: 2, nextStatus: 'succeeded', context: context('s-3') })).status, 200);

    // Restart.
    assert.equal(runScript('stop', ['--config', svc.config]).json.mode, 'graceful');
    assert.equal(runScript('start', ['--config', svc.config]).json.result, 'started');
    assert.equal((await (await api(svc.endpoint, '/v1/tasks/task-1')).json() as { status: string }).status, 'succeeded');

    // Notification: consented, minimized, accepted by the transport, then read by the human.
    const notes = createNotificationCenter({ databasePath: join(svc.data, 'notifications.sqlite'), operatorAuthority: operator });
    try {
      notes.setConsent('local', true, operator);
      notes.notify({ id: 'task-1:succeeded', channel: 'local', category: 'task_finished', ref: 'task-1' });
      assert.equal((await notes.deliver('local', note => { toasts.push(note); })).accepted, 1);
      assert.equal(notes.list()[0].state, 'accepted');
      notes.markRead('task-1:succeeded', 'local');
    } finally { notes.close(); }
    assert.deepEqual(toasts, [{ id: 'task-1:succeeded', text: 'An assistant task finished.', ref: 'task-1' }]);

    // Backup while a second effect is still queued; it is sent afterwards.
    enqueue(svc.data, 'send-b', 'mail B');
    const saved = runScript('backup', ['--config', svc.config, '--out', backup]);
    assert.equal(saved.status, 0, saved.stdout + saved.stderr);
    assert.equal(contains(readFileSync(backup), CANARY), false, 'the backup holds no plaintext task content');
    runWorker(svc.data, sink);
    assert.deepEqual(sent(sink), ['mail A', 'mail B']);

    // Restore into a disposable directory, start it on its own port and query.
    const restored = runScript('restore', ['--backup', backup, '--into', restoredDir, '--profile', PROFILE]);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    writeConfig(restoredHome.config, join(restoredDir, 'tasks.sqlite'), restoredHome.endpoint);
    assert.equal(runScript('start', ['--config', restoredHome.config]).json.result, 'started');
    const task = await (await api(restoredHome.endpoint, '/v1/tasks/task-1')).json() as { status: string; title: string };
    assert.deepEqual([task.status, task.title], ['succeeded', `journey ${CANARY}`]);

    // Running the worker on the restored state repeats nothing; the uncertain effect stays visible.
    runWorker(restoredDir, sink);
    assert.deepEqual(sent(sink), ['mail A', 'mail B'], 'zero external effect repetition');
    const view = createRuntime({ databasePath: join(restoredDir, 'runtime.sqlite'), owner: 'view' });
    try { assert.deepEqual(view.jobs().map(j => [j.id, j.state]), [['send-a', 'done'], ['send-b', 'effect_uncertain']]); } finally { view.close(); }
    const restoredNotes = createNotificationCenter({ databasePath: join(restoredDir, 'notifications.sqlite'), operatorAuthority: operator });
    try {
      await restoredNotes.deliver('local', note => { toasts.push(note); });
      assert.equal(toasts.length, 1, 'the notification is delivered once logically');
      assert.equal(restoredNotes.list()[0].state, 'read');
    } finally { restoredNotes.close(); }

    for (const config of [svc.config, restoredHome.config]) assert.equal(runScript('stop', ['--config', config]).json.result, 'stopped');
    assert.doesNotMatch(readFileSync(join(svc.home, 'assistant-service.log'), 'utf8'), new RegExp(TOKEN));
  } finally { killRecordedService(svc.home); killRecordedService(restoredHome.home); }
}));
