import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/store/db.ts';
import { createBackup, restoreBackup } from '../src/ops/backup.ts';
import { createPrivateDirectory } from '../src/store/private-directory.ts';
import { freePort, launchWeb } from './ops-support.ts';
import { queuedTask, storeEvent } from './task-fixtures.ts';
import { memoryProtector } from './vault-support.ts';

test('the restored service shows held task revisions read-only in the panel inspection and requeues nothing', { timeout: 60000 }, async () => {
  const root = join(tmpdir(), 'executor-restore-panel-' + randomUUID()); createPrivateDirectory(root);
  const data = join(root, 'data'), restored = join(root, 'restored'), out = join(root, 'snapshot.backup'); mkdirSync(data, { mode: 0o700 }); mkdirSync(restored, { mode: 0o700 });
  const profileId = 'restore-panel', token = randomUUID(), { protector } = memoryProtector();
  const store = new TaskStore(join(data, 'tasks.sqlite'), profileId);
  const event = (taskId: string, sourceEventId = randomUUID()) => storeEvent(profileId, taskId, store.nextSequence(), { eventId: randomUUID(), sourceEventId, correlationId: randomUUID(), actorId: 'operator', sourceKind: 'trusted-local-human', reference: 'test' });
  try {
    for (const id of ['waiting', 'inflight']) store.create(queuedTask(profileId, id, `Tarefa ${id}`, `source-${id}`), event(id, `source-${id}`));
    store.transition('inflight', 1, 'working', event('inflight'));
    await createBackup({ databasePath: join(data, 'tasks.sqlite'), profileId, out, protector });
  } finally { store.close(); }
  await restoreBackup({ backup: out, into: restored, profileId, protector });
  const endpoint = `http://127.0.0.1:${await freePort()}`, config = join(restored, 'config.json');
  writeFileSync(config, JSON.stringify({ version: 1, profileId, token, endpoint, databasePath: join(restored, 'tasks.sqlite') }));
  let running: ReturnType<typeof launchWeb> | undefined;
  try {
    running = launchWeb(config); await running.ready;
    const login = await fetch(endpoint + '/web/session', { method: 'POST', headers: { origin: endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const inspection = await (await fetch(endpoint + '/web/api/inspection', { headers: { cookie } })).json() as { restored: { taskId: string; revision: number; title: string; status: string }[] };
    assert.deepEqual(inspection.restored, [{ taskId: 'inflight', revision: 2, title: 'Tarefa inflight', status: 'working' }, { taskId: 'waiting', revision: 1, title: 'Tarefa waiting', status: 'queued' }]);
    const tasks = await (await fetch(endpoint + '/web/api/tasks', { headers: { cookie } })).json() as { tasks: { taskId: string; status: string; revision: number }[] };
    assert.deepEqual(tasks.tasks.map(t => [t.taskId, t.status, t.revision]).sort(), [['inflight', 'working', 2], ['waiting', 'queued', 1]]);
  } finally { await running?.stop(); rmSync(root, { recursive: true, force: true }); }
});
