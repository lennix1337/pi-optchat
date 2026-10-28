import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoutines } from '../src/routines/manager.ts';
import type { WorkerRuntime } from '../src/runtime/worker.ts';
import { daily, drain, rig, utc } from './routine-support.ts';
import { withDir } from './runtime-support.ts';

test('a routine is bound to profile, capabilities and authorization, and starts paused until activated', () => withDir('routines-', async dir => {
  const seen: unknown[] = [];
  const r = await rig(dir, '2026-10-28T08:00:00Z', { brief: input => { seen.push(input); return 'ok'; } });
  try {
    const created = r.routines.create(daily('morning', '09:00', { input: { topic: 'mail' } }));
    assert.deepEqual([created.state, created.pausedReason, created.nextRunAt], ['paused', 'not_activated', null]);
    assert.throws(() => r.routines.create(daily('morning')), /routine_exists/u);
    r.clock.now = utc('2026-10-28T09:30:00Z');
    assert.deepEqual(r.routines.tick().claimed, [], 'creation alone schedules nothing');
    assert.throws(() => r.routines.resume('morning', ''), /invalid_id/u, 'activation names the operator');
    const active = r.routines.resume('morning', 'operator');
    assert.deepEqual([active.state, active.activatedBy, active.nextRunAt], ['active', 'operator', utc('2026-10-29T09:00:00Z')], 'paused time is not missed time');
    r.clock.now = utc('2026-10-29T09:00:00Z');
    assert.deepEqual(r.routines.tick().enqueued, ['routine:morning:2026-10-29T09:00']);
    await drain(r.runtime);
    assert.deepEqual(seen, [{ routineId: 'morning', profileId: 'p', slot: '2026-10-29T09:00', scheduledAt: utc('2026-10-29T09:00:00Z'), missed: 0,
      capabilities: ['read.inbox'], authorization: 'grant-1', input: { topic: 'mail' } }]);
    r.routines.tick();
    assert.deepEqual(r.routines.history('morning').map(run => [run.slot, run.status]), [['2026-10-29T09:00', 'done']]);
    assert.equal(r.routines.get('morning').nextRunAt, utc('2026-10-30T09:00:00Z'), 'next time is visible');
  } finally { await r.close(); }
}));

test('edit, pause, resume and delete; widening what a routine may do needs re-activation', () => withDir('routines-', async dir => {
  const r = await rig(dir, '2026-10-28T08:00:00Z', { brief: () => 'ok', other: () => 'ok' });
  try {
    r.routines.create(daily('a'));
    r.routines.resume('a', 'operator');
    const moved = r.routines.edit('a', { schedule: { kind: 'daily', at: '10:15', timeZone: 'UTC' }, input: { v: 2 } });
    assert.deepEqual([moved.state, moved.nextRunAt, moved.input], ['active', utc('2026-10-28T10:15:00Z'), { v: 2 }], 'a schedule edit keeps it active');
    for (const patch of [{ capabilities: ['read.inbox', 'send.mail'] }, { authorization: 'grant-2' }, { kind: 'other' }, { profileId: 'q' }]) {
      const widened = r.routines.edit('a', patch);
      assert.deepEqual([widened.state, widened.pausedReason, widened.nextRunAt], ['paused', 'needs_reactivation', null], JSON.stringify(patch));
      r.routines.resume('a', 'operator');
    }
    assert.equal(r.routines.pause('a').pausedReason, 'operator');
    r.clock.now = utc('2026-10-30T12:00:00Z');
    assert.deepEqual(r.routines.tick().claimed, [], 'a paused routine does not run');
    r.routines.resume('a', 'operator');
    assert.deepEqual(r.routines.list('q').map(x => x.id), ['a']);
    assert.deepEqual(r.routines.list('p'), []);
    r.clock.now = utc('2026-10-31T10:15:00Z');
    r.routines.tick();
    r.routines.delete('a');
    assert.deepEqual(r.routines.list(), []);
    assert.throws(() => r.routines.get('a'), /unknown_routine/u);
    assert.equal(r.routines.history('a').length, 1, 'history survives deletion');
    r.clock.now = utc('2026-11-01T10:15:00Z');
    assert.deepEqual(r.routines.tick().claimed, []);
  } finally { await r.close(); }
}));

test('existing wakes and dreams are adopted paused, without capabilities or authorization, and never run on adoption', () => withDir('routines-', async dir => {
  const r = await rig(dir, '2026-10-28T02:00:00Z', { dream: () => 'ok' });
  try {
    const legacy = { id: 'optchat-dream', profileId: 'p', kind: 'dream', schedule: { kind: 'daily' as const, at: '03:00', timeZone: 'America/Sao_Paulo' }, source: 'legacy-wake' };
    const adopted = r.routines.adopt(legacy);
    assert.deepEqual([adopted.state, adopted.pausedReason, adopted.capabilities, adopted.authorization, adopted.source], ['paused', 'not_activated', [], null, 'legacy-wake']);
    assert.deepEqual(r.routines.adopt({ ...legacy, schedule: { kind: 'daily', at: '04:00', timeZone: 'UTC' } }).schedule, legacy.schedule, 'adopting twice changes nothing');
    r.clock.now = utc('2026-10-30T12:00:00Z');
    assert.deepEqual(r.routines.tick().claimed, []);
    assert.deepEqual(r.runtime.jobs(), []);
  } finally { await r.close(); }
}));

test('a routine never overlaps itself: a slot due while its previous job is unfinished is skipped and recorded', () => withDir('routines-', async dir => {
  const r = await rig(dir, '2026-10-28T08:00:00Z', { brief: () => 'ok' });
  try {
    r.routines.create(daily('a'));
    r.routines.resume('a', 'operator');
    r.clock.now = utc('2026-10-28T09:00:00Z');
    r.routines.tick();
    r.clock.now = utc('2026-10-29T09:00:00Z');
    assert.deepEqual(r.routines.tick().claimed, [], 'the first job is still queued');
    assert.deepEqual(r.routines.history('a').map(run => [run.slot, run.status, run.detail]), [
      ['2026-10-29T09:00', 'skipped_overlap', 'routine:a:2026-10-28T09:00'], ['2026-10-28T09:00', 'enqueued', null]]);
    await drain(r.runtime);
    r.clock.now = utc('2026-10-30T09:00:00Z');
    assert.deepEqual(r.routines.tick().enqueued, ['routine:a:2026-10-30T09:00']);
  } finally { await r.close(); }
}));

test('a full worker queue keeps the claim and retries the same job id; it is not a failure', () => withDir('routines-', async dir => {
  const r = await rig(dir, '2026-10-28T08:00:00Z', { brief: () => 'ok' }, { maxQueued: 1 });
  try {
    r.runtime.enqueue('other', 'brief', {});
    r.routines.create(daily('a'));
    r.routines.resume('a', 'operator');
    r.clock.now = utc('2026-10-28T09:00:00Z');
    assert.deepEqual(r.routines.tick(), { claimed: ['routine:a:2026-10-28T09:00'], enqueued: [] });
    assert.deepEqual(r.routines.history('a').map(run => [run.status, run.detail]), [['claimed', 'queue_full']]);
    assert.equal(r.routines.get('a').failures, 0);
    await drain(r.runtime);
    assert.deepEqual(r.routines.tick().enqueued, ['routine:a:2026-10-28T09:00']);
    await drain(r.runtime);
    r.routines.tick();
    assert.equal(r.routines.history('a')[0].status, 'done');
  } finally { await r.close(); }
}));

test('consecutive failures suspend the routine with a visible reason; a success resets the count', () => withDir('routines-', async dir => {
  let fail = true;
  const r = await rig(dir, '2026-10-28T08:00:00Z', { brief: () => { if (fail) throw new Error('provider down'); return 'ok'; } }, { maxAttempts: 1 });
  try {
    r.routines.create(daily('a', '09:00', { maxFailures: 2 }));
    r.routines.resume('a', 'operator');
    const day = async (iso: string) => { r.clock.now = utc(iso); r.routines.tick(); await drain(r.runtime); r.routines.tick(); };
    await day('2026-10-28T09:00:00Z');
    assert.deepEqual([r.routines.get('a').failures, r.routines.get('a').state], [1, 'active']);
    fail = false;
    await day('2026-10-29T09:00:00Z');
    assert.equal(r.routines.get('a').failures, 0, 'a success resets consecutive failures');
    fail = true;
    await day('2026-10-30T09:00:00Z');
    await day('2026-10-31T09:00:00Z');
    const suspended = r.routines.get('a');
    assert.deepEqual([suspended.state, suspended.pausedReason, suspended.failures, suspended.nextRunAt], ['paused', 'consecutive_failures', 2, null]);
    assert.deepEqual(r.routines.history('a').map(run => [run.status, run.detail]).slice(0, 2), [['failed', 'attempts_exhausted'], ['failed', 'attempts_exhausted']]);
    r.clock.now = utc('2026-11-01T09:00:00Z');
    assert.deepEqual(r.routines.tick().claimed, [], 'a suspended routine stays suspended');
  } finally { await r.close(); }
}));

test('an uncertain effect suspends the routine for reconciliation instead of counting as a retryable failure', () => withDir('routines-', async dir => {
  const jobs = new Map<string, { state: string; error: string | null }>();
  const runtime = {
    enqueue(id: string) { jobs.set(id, { state: 'queued', error: null }); return {}; },
    job(id: string) { return jobs.get(id); },
  } as unknown as WorkerRuntime;
  let now = utc('2026-10-28T08:00:00Z');
  const routines = createRoutines({ databasePath: `${dir}/routines.db`, runtime, now: () => now });
  try {
    routines.create(daily('send', '09:00', { kind: 'effect', maxFailures: 5 }));
    routines.resume('send', 'operator');
    now = utc('2026-10-28T09:00:00Z');
    const [jobId] = routines.tick().enqueued;
    jobs.set(jobId, { state: 'effect_uncertain', error: 'effect_uncertain' });
    routines.tick();
    const routine = routines.get('send');
    assert.deepEqual([routine.state, routine.pausedReason], ['paused', 'effect_uncertain']);
    assert.deepEqual(routines.history('send').map(run => [run.status, run.detail]), [['failed', 'effect_uncertain']]);
  } finally { routines.close(); }
}));

test('invalid routine specs are refused before anything is stored', () => withDir('routines-', async dir => {
  const r = await rig(dir, '2026-10-28T08:00:00Z', { brief: () => 'ok' });
  try {
    for (const bad of [
      daily('bad id'), daily('a', '09:00', { profileId: '' }), daily('a', '25:00'), daily('a', '09:00', { capabilities: ['ok', 'not ok'] }),
      daily('a', '09:00', { missed: 'replay' as never }), daily('a', '09:00', { maxFailures: 0 }), daily('a', '09:00', { input: 'x'.repeat(20_000) }),
    ]) assert.throws(() => r.routines.create(bad), /invalid_/u, bad.id);
    assert.deepEqual(r.routines.list(), []);
  } finally { await r.close(); }
}));
