import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRoutines } from '../src/routines/manager.ts';
import { daily, drain, rig, utc } from './routine-support.ts';
import { withDir } from './runtime-support.ts';

test('after downtime a routine runs once for the newest slot and reports how many it missed', () => withDir('missed-', async dir => {
  const seen: { slot: string; missed: number }[] = [];
  const r = await rig(dir, '2026-10-01T08:00:00Z', { brief: input => { seen.push(input as { slot: string; missed: number }); } });
  try {
    r.routines.create(daily('a'));
    r.routines.resume('a', 'operator');
    r.clock.now = utc('2026-10-06T10:00:00Z');
    assert.deepEqual(r.routines.tick().enqueued, ['routine:a:2026-10-06T09:00'], 'one consolidated run, not six');
    await drain(r.runtime);
    assert.deepEqual(seen.map(x => [x.slot, x.missed]), [['2026-10-06T09:00', 5]], '10-01..10-05 were missed');
    assert.deepEqual(r.routines.tick().claimed, [], 'a second tick at the same time runs nothing');
    assert.equal(r.routines.get('a').nextRunAt, utc('2026-10-07T09:00:00Z'));
  } finally { await r.close(); }
}));

test('the skip policy drops a slot missed beyond its grace and records it', () => withDir('missed-', async dir => {
  const r = await rig(dir, '2026-10-01T08:00:00Z', { brief: () => 'ok' });
  try {
    r.routines.create(daily('late', '09:00', { missed: 'skip', graceMs: 30 * 60_000 }));
    r.routines.resume('late', 'operator');
    r.clock.now = utc('2026-10-01T09:20:00Z');
    assert.equal(r.routines.tick().enqueued.length, 1, 'within grace it runs');
    await drain(r.runtime);
    r.clock.now = utc('2026-10-03T12:00:00Z');
    assert.deepEqual(r.routines.tick().claimed, []);
    assert.deepEqual(r.routines.history('late')[0], { routineId: 'late', slot: '2026-10-03T09:00', at: utc('2026-10-03T12:00:00Z'), status: 'skipped_missed', jobId: null, missed: 2, detail: null });
    assert.equal(r.routines.get('late').nextRunAt, utc('2026-10-04T09:00:00Z'));
  } finally { await r.close(); }
}));

test('a clock that moves backwards fires nothing and is reported; the same slot never runs twice', () => withDir('missed-', async dir => {
  const r = await rig(dir, '2026-10-01T08:00:00Z', { brief: () => 'ok' });
  try {
    r.routines.create(daily('a'));
    r.routines.resume('a', 'operator');
    r.clock.now = utc('2026-10-01T09:05:00Z');
    r.routines.tick();
    await drain(r.runtime);
    r.clock.now = utc('2026-10-01T08:55:00Z');
    assert.deepEqual(r.routines.tick().claimed, [], 'rewound clock');
    assert.equal(r.routines.history('a')[0].status, 'clock_skew');
    r.clock.now = utc('2026-10-01T09:06:00Z');
    assert.deepEqual(r.routines.tick().claimed, [], '09:00 already ran');
    assert.deepEqual(r.runtime.jobs().map(job => job.id), ['routine:a:2026-10-01T09:00']);
  } finally { await r.close(); }
}));

test('two schedulers on one database, with diverging clocks, enqueue each slot once', () => withDir('missed-', async dir => {
  const r = await rig(dir, '2026-10-01T08:00:00Z', { brief: () => 'ok' });
  let behind = utc('2026-10-01T08:59:00Z');
  const other = createRoutines({ databasePath: join(dir, 'assistant.db'), runtime: r.runtime, now: () => behind });
  try {
    r.routines.create(daily('a'));
    r.routines.resume('a', 'operator');
    for (const iso of ['2026-10-01T09:00:00Z', '2026-10-01T09:00:01Z']) {
      r.clock.now = utc(iso);
      const first = r.routines.tick().claimed; const second = other.tick().claimed;
      assert.equal(first.length + second.length, iso.endsWith('00Z') ? 1 : 0, iso);
    }
    behind = utc('2026-10-01T09:10:00Z');
    assert.deepEqual(other.tick().claimed, [], 'the lagging scheduler catches up without repeating the slot');
    await drain(r.runtime);
    r.clock.now = utc('2026-10-02T09:00:00Z');
    behind = utc('2026-10-02T09:00:00Z');
    const claimed = [...other.tick().claimed, ...r.routines.tick().claimed];
    assert.deepEqual(claimed, ['routine:a:2026-10-02T09:00']);
    assert.deepEqual(r.runtime.jobs().map(job => job.id), ['routine:a:2026-10-01T09:00', 'routine:a:2026-10-02T09:00']);
  } finally { other.close(); await r.close(); }
}));

test('a scheduler that dies between claim and enqueue is completed by the next tick with the same job id', () => withDir('missed-', async dir => {
  const r = await rig(dir, '2026-10-01T08:00:00Z', { brief: () => 'ok' });
  const crashing = createRoutines({ databasePath: join(dir, 'assistant.db'), runtime: r.runtime, now: () => r.clock.now,
    boundary: name => { if (name === 'claimed') throw new Error('crash'); } });
  try {
    r.routines.create(daily('a'));
    r.routines.resume('a', 'operator');
    r.clock.now = utc('2026-10-01T09:00:00Z');
    assert.throws(() => crashing.tick(), /crash/u);
    assert.deepEqual(r.runtime.jobs(), [], 'claimed, not yet enqueued');
    crashing.close();
    // Restart: a new scheduler on the same database.
    const restarted = createRoutines({ databasePath: join(dir, 'assistant.db'), runtime: r.runtime, now: () => r.clock.now });
    try {
      assert.deepEqual(restarted.tick(), { claimed: [], enqueued: ['routine:a:2026-10-01T09:00'] });
      assert.deepEqual(restarted.tick().enqueued, [], 'never enqueued twice');
      await drain(r.runtime);
      restarted.tick();
      assert.deepEqual(restarted.history('a').map(run => run.status), ['done']);
    } finally { restarted.close(); }
  } finally { await r.close(); }
}));

test('moving a routine to a zone where its next local slot already ran skips that slot and keeps scheduling', () => withDir('missed-', async dir => {
  const r = await rig(dir, '2026-10-28T08:00:00Z', { brief: () => 'ok' });
  try {
    r.routines.create(daily('a'));
    r.routines.resume('a', 'operator');
    r.clock.now = utc('2026-10-28T09:00:00Z');
    r.routines.tick(); await drain(r.runtime);
    r.clock.now = utc('2026-10-28T10:00:00Z');
    r.routines.edit('a', { schedule: { kind: 'daily', at: '09:00', timeZone: 'America/Sao_Paulo' } });
    r.clock.now = utc('2026-10-28T12:00:00Z');
    assert.deepEqual(r.routines.tick().claimed, [], '2026-10-28T09:00 local already ran');
    assert.equal(r.routines.get('a').nextRunAt, utc('2026-10-29T12:00:00Z'), 'the schedule moves on');
    r.clock.now = utc('2026-10-29T12:00:00Z');
    assert.deepEqual(r.routines.tick().claimed, ['routine:a:2026-10-29T09:00']);
  } finally { await r.close(); }
}));

test('a DST fold with the machine asleep across it still runs the local slot once', () => withDir('missed-', async dir => {
  const seen: string[] = [];
  const r = await rig(dir, '2026-10-31T12:00:00Z', { brief: input => { seen.push((input as { slot: string }).slot); } });
  try {
    r.routines.create(daily('a', '01:30', { schedule: { kind: 'daily', at: '01:30', timeZone: 'America/New_York' } }));
    r.routines.resume('a', 'operator');
    for (const iso of ['2026-11-01T05:30:00Z', '2026-11-01T06:00:00Z', '2026-11-01T06:30:00Z', '2026-11-01T07:00:00Z']) {
      r.clock.now = utc(iso); r.routines.tick(); await drain(r.runtime);
    }
    assert.deepEqual(seen, ['2026-11-01T01:30'], '01:30 EST after the fold is not a second run');
  } finally { await r.close(); }
}));
