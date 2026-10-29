import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutineService, TASK_KIND, parseRoutineTask } from '../src/routines/service.ts';
import { TaskStore } from '../src/store/db.ts';
import { createPrivateDirectory } from '../src/store/private-directory.ts';
import { queuedTask, storeEvent } from './task-fixtures.ts';
import { runScript } from './ops-support.ts';

const PROFILE = 'routine-owner';
const MINUTE = 60_000;

function fixture() {
  const dir = join(tmpdir(), 'routine-service-unit-' + randomUUID()); createPrivateDirectory(dir);
  const clock = { now: Date.UTC(2026, 9, 29, 12, 0, 0) };
  const tasksDatabase = join(dir, 'tasks.sqlite');
  const store = new TaskStore(tasksDatabase, PROFILE);
  const service = new RoutineService({ store, profileId: PROFILE, tasksDatabase, now: () => clock.now });
  return { dir, clock, store, service, tasksDatabase,
    async close() { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const every = (minutes: number, anchor: number) => ({ kind: 'interval' as const, minutes, anchor });

test('a slot becomes one queued task in its channel; missed slots are consolidated into one, never replayed', async () => {
  const f = fixture();
  try {
    f.service.routines.create({ id: 'resumo', profileId: PROFILE, kind: TASK_KIND, input: { title: 'Resumo', channelId: 'Pessoal' }, schedule: every(1, f.clock.now) });
    await f.service.tick();
    assert.equal(f.store.list().tasks.length, 0, 'paused: nothing');
    f.service.routines.resume('resumo', 'operador');
    f.clock.now += 5 * MINUTE + 1000;
    await f.service.tick(); await f.service.tick();
    const [task, ...rest] = f.store.list().tasks;
    assert.deepEqual(rest, []);
    assert.equal(task.status, 'queued');
    assert.equal(task.title, 'Resumo');
    const origin = f.store.creation(task.taskId)!.event;
    assert.equal(origin.channelId, 'Pessoal');
    assert.match(origin.evidence.reference, /4 horário\(s\) perdido\(s\) consolidado/);
    assert.equal(f.service.created(origin), true);
    assert.deepEqual(f.service.routines.history('resumo').map(run => run.status), ['done']);
  } finally { await f.close(); }
});

test('a task whose source merely claims a routine is not vouched for', async () => {
  const f = fixture();
  try {
    const forged = storeEvent(PROFILE, 'forged', f.store.nextSequence(), { eventId: 'e1', sourceEventId: 'routine:resumo:2026-10-29T12:00', correlationId: 'c1', actorId: 'routine:resumo', sourceKind: 'worker', reference: 'x' });
    f.store.create(queuedTask(PROFILE, 'forged', 'Forjada', forged.source.sourceEventId), forged);
    assert.equal(f.service.created(f.store.creation('forged')!.event), false);
    const human = { ...forged, source: { ...forged.source, sourceKind: 'trusted-local-human' as const } };
    assert.equal(f.service.created(human), false);
  } finally { await f.close(); }
});

test('a routine of another profile or with a malformed task fails its run without creating anything', async () => {
  const f = fixture();
  try {
    f.service.routines.create({ id: 'outro', profileId: 'other-profile', kind: TASK_KIND, input: { title: 'X', channelId: 'Pessoal' }, schedule: every(1, f.clock.now), maxFailures: 1 });
    f.service.routines.create({ id: 'ruim', profileId: PROFILE, kind: TASK_KIND, input: { title: 'X', channelId: 'Pessoal', extra: 1 }, schedule: every(1, f.clock.now), maxFailures: 1 });
    for (const id of ['outro', 'ruim']) f.service.routines.resume(id, 'operador');
    f.clock.now += MINUTE + 1000;
    for (let i = 0; i < 5; i++) await f.service.tick();
    assert.equal(f.store.list().tasks.length, 0);
    for (const id of ['outro', 'ruim']) {
      assert.deepEqual(f.service.routines.history(id).map(run => run.status), ['failed']);
      assert.equal(f.service.routines.get(id).pausedReason, 'consecutive_failures');
    }
  } finally { await f.close(); }
});

test('routine tasks accept only a short single-line title and channel', () => {
  assert.deepEqual(parseRoutineTask({ title: 'Resumo', channelId: 'Pessoal' }), { title: 'Resumo', channelId: 'Pessoal' });
  for (const bad of [null, [], { title: 'a' }, { title: '', channelId: 'P' }, { title: 'a\nb', channelId: 'P' }, { title: 'a'.repeat(201), channelId: 'P' }, { title: 'a', channelId: 'P', x: 1 }]) {
    assert.throws(() => parseRoutineTask(bad), /invalid_routine_task/);
  }
});

test('routine CLI refuses a service without routines and malformed commands', () => {
  const dir = join(tmpdir(), 'routine-cli-' + randomUUID()); createPrivateDirectory(dir);
  try {
    const config = join(dir, 'config.json');
    const base = { version: 1, profileId: PROFILE, databasePath: join(dir, 'tasks.sqlite'), endpoint: 'http://127.0.0.1:1', token: 'routine-cli-token' };
    writeFileSync(config, JSON.stringify(base));
    const disabled = runScript('routine', ['list', '--config', config]);
    assert.equal(disabled.status, 1);
    assert.equal(disabled.json.code, 'routines_disabled');
    writeFileSync(config, JSON.stringify({ ...base, routines: true }));
    assert.equal(runScript('routine', ['resume', '--config', config, '--id', 'x']).status, 2, 'resume needs a named operator');
    assert.equal(runScript('routine', ['list', '--config', config, '--id', 'x']).status, 2, 'unexpected option');
    const badSchedule = runScript('routine', ['create', '--config', config, '--id', 'r', '--title', 'T', '--channel', 'P', '--schedule', '{"kind":"hourly"}']);
    assert.equal(badSchedule.json.code, 'invalid_schedule');
    const unknown = runScript('routine', ['pause', '--config', config, '--id', 'nada']);
    assert.equal(unknown.json.code, 'unknown_routine');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
