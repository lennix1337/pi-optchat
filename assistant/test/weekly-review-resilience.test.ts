import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withGoogle } from './google-support.ts';
import { SUNDAY_EVENING, composer, section, seed } from './weekly-support.ts';

for (const status of [401, 429, 404]) {
  test(`a Gmail thread check returning ${status} only stops later checks for an account-wide error`, () => withGoogle(async rig => {
    rig.clock.now = SUNDAY_EVENING;
    for (const [account, count] of [['personal', 3], ['dentai', 1]] as const) {
      for (let i = 0; i < count; i++) rig.fake.mail[account].push({ id: `${account}-${i}`, from: 'Ana <ana@example.test>', subject: `Proposal ${i}`, body: 'Can you look?', receivedAt: `2026-10-30T1${i}:00:00.000Z` });
    }
    await rig.connect('personal', 'personal');
    await rig.connect('dentai', 'dentai');
    rig.fake.failures.set('/gmail/v1/users/me/threads/thread-personal-2', status);
    const { briefing } = await composer(rig).weekly();
    const reads = rig.fake.log.filter(entry => entry.path.startsWith('/gmail/v1/users/me/threads/'));
    assert.deepEqual(reads.filter(entry => entry.account === 'personal').map(entry => entry.path.split('/').at(-1)),
      status === 404 ? ['thread-personal-2', 'thread-personal-1', 'thread-personal-0'] : ['thread-personal-2']);
    assert.equal(reads.filter(entry => entry.account === 'dentai').length, 1, 'the other connection keeps checking');
    assert.equal(briefing.sources.find(source => source.sourceId === 'personal:mail')?.state, 'partial');
    const unverified = section(briefing, 'messages').filter(item => item.reason === 'awaiting_reply_unverified');
    assert.equal(unverified.length, status === 404 ? 1 : 3, 'unchecked candidates remain explicitly unverified');
    assert.ok(unverified.every(item => item.sourceRef.startsWith('gmail:personal:') && item.uncertainty === 'high'));
  }));
}

test('a source that fails is listed, and the rest of the review still arrives', () => withGoogle(async rig => {
  await seed(rig);
  rig.fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig);
  const { briefing, created, complete } = await c.weekly();
  assert.equal(briefing.sources.find(s => s.sourceId === 'personal:calendar')?.state, 'unavailable');
  assert.deepEqual([created, complete, c.latestWeekly()], [false, false, null], 'an incomplete review is not stored as the final one');
  assert.equal(section(briefing, 'agenda').filter(i => i.reason !== 'source_unavailable').length, 0);
  assert.equal(section(briefing, 'messages').length, 3);
}));

test('thread checks are bounded per connection, and a thread that cannot be checked is listed as uncertain without losing the review', () => withGoogle(async rig => {
  await rig.connect('personal', 'personal');
  await rig.connect('dentai', 'dentai');
  rig.fake.pageSize = 50;
  for (let i = 0; i < 30; i++) rig.fake.mail.personal.push({ id: `m${i}`, from: `Ana <ana${i}@example.test>`, subject: 'Proposal for review', body: 'Can you look?', receivedAt: new Date(Date.parse('2026-10-30T12:00:00.000Z') + i * 60_000).toISOString() });
  rig.fake.failures.set('/gmail/v1/users/me/threads/thread-m29', 500);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig);
  const { briefing, created, complete } = await c.weekly();
  const checks = rig.fake.log.filter(entry => entry.path.startsWith('/gmail/v1/users/me/threads/'));
  assert.ok(checks.length <= 25, `${checks.length} thread reads`);
  assert.deepEqual([created, complete], [true, true], 'one thread failing does not make the source unavailable');
  assert.equal(briefing.sources.find(s => s.sourceId === 'personal:mail')?.state, 'partial');
  const waiting = section(briefing, 'messages');
  assert.equal(waiting.length, 30, 'unchecked threads are still listed');
  const unchecked = waiting.filter(i => i.reason === 'awaiting_reply_unverified').map(i => i.sourceRef).sort();
  assert.ok(waiting.filter(i => i.reason === 'awaiting_reply').every(i => i.uncertainty !== 'high'), 'a verified thread is not marked uncertain');
  assert.ok(waiting.filter(i => i.reason === 'awaiting_reply_unverified').every(i => i.uncertainty === 'high'));
  assert.deepEqual(unchecked, ['m29', 'm0', 'm1', 'm2', 'm3', 'm4'].map(id => `gmail:personal:${id}`).sort(), 'the failed read and the five beyond the limit');
}));

test('a review recovered after its boundary reads the days after it is composed, not a window cut from the missed Sunday', () => withGoogle(async rig => {
  await seed(rig);
  rig.clock.now = Date.parse('2026-11-03T15:00:00.000Z');
  const { briefing, created } = await composer(rig).weekly('2026-11-01');
  assert.equal(created, true);
  assert.equal(briefing.localDate, '2026-11-01');
  const titles = section(briefing, 'agenda').map(i => i.title.replace(/^\S+ \S+ /, ''));
  assert.ok(titles.includes('The week after'), 'the seven days after the recovery day, up to the Tuesday after');
  assert.ok(titles.includes('Retro') && !titles.includes('Planning'), 'days before the window are out');
  const windows = () => rig.fake.log.filter(entry => entry.path === '/calendar/v3/calendars/primary/events').map(entry => [entry.params.timeMin, entry.params.timeMax]);
  assert.deepEqual(windows()[0], ['2026-11-03T15:00:00.000Z', '2026-11-11T03:00:00.000Z'], 'a late review starts when it is composed, so what is still ahead of the missed Monday and Tuesday is in');
  rig.fake.log.length = 0;
  rig.clock.now = Date.parse('2026-11-08T21:30:00.000Z');
  await composer(rig).weekly('2026-11-08');
  assert.deepEqual(windows()[0], ['2026-11-09T03:00:00.000Z', '2026-11-16T03:00:00.000Z'], 'on time it starts at the Monday');
}));

test('a source that stays down degrades the review after a few tries, a total outage never does, and the attempt is cleared once it is saved', () => withGoogle(async rig => {
  await seed(rig);
  rig.fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig);
  const results: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    results.push((await c.weekly()).complete);
    if (!results[i]) assert.equal(c.weeklyAttempt('2026-11-01')?.tries, i + 1, 'an unsaved review keeps its attempt');
    rig.clock.now += 16 * 60_000;
  }
  assert.deepEqual(results, [false, false, true]);
  const stored = c.latestWeekly()!;
  assert.deepEqual(stored.sources.filter(s => s.state === 'unavailable').map(s => s.sourceId), ['personal:calendar', 'dentai:calendar']);
  assert.equal(c.weeklyAttempt('2026-11-01')?.tries, 3, 'a degraded review keeps its attempt as the clock for recovering it');
  const missing = stored.items.filter(i => i.reason === 'source_unavailable');
  assert.deepEqual(missing.map(i => [i.section, i.sourceRef, i.urgency, i.uncertainty]), [['agenda', 'source:personal:calendar', 'urgent', 'high'], ['agenda', 'source:dentai:calendar', 'urgent', 'high']], 'the review says what is missing, so no conflicts is not read as none exist');
  assert.ok(missing.every(i => /not included/.test(i.title) && !i.untrusted && !i.startable));
  assert.equal(section(stored, 'tasks').length, 1);
}));

test('when every Google source is down the review is held, however many tries', () => withGoogle(async rig => {
  await seed(rig);
  rig.fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  rig.fake.failures.set('/gmail/v1/users/me/messages', 500);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig);
  for (let i = 0; i < 5; i++) { assert.equal((await c.weekly()).complete, false); rig.clock.now += 16 * 60_000; }
  assert.equal(c.latestWeekly(), null);
}));

test('an outage of tasks and every Google source never stores a weekly review', () => withGoogle(async rig => {
  await seed(rig);
  rig.store.list = () => { throw new Error('store_down'); };
  rig.fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  rig.fake.failures.set('/gmail/v1/users/me/messages', 500);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig);
  for (let i = 0; i < 5; i++) {
    const { briefing, complete, created } = await c.weekly();
    assert.deepEqual(briefing.sources.map(({ sourceId, state }) => [sourceId, state]), [
      ['tasks', 'unavailable'], ['personal:mail', 'unavailable'], ['personal:calendar', 'unavailable'],
      ['dentai:mail', 'unavailable'], ['dentai:calendar', 'unavailable'],
    ]);
    assert.equal(complete, false, `attempt ${i + 1} must stay incomplete`);
    assert.equal(created, false);
    assert.equal(c.latestWeekly(), null);
    rig.clock.now += 16 * 60_000;
  }
}));

test('a partial Google outage with tasks down stores a degraded weekly review on the third try', () => withGoogle(async rig => {
  await seed(rig);
  rig.store.list = () => { throw new Error('store_down'); };
  rig.fake.failures.set('/gmail/v1/users/me/messages', 500);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig, ['personal']);
  for (let i = 0; i < 2; i++) {
    assert.equal((await c.weekly()).complete, false);
    assert.equal(c.latestWeekly(), null);
    rig.clock.now += 16 * 60_000;
  }

  const { briefing, complete, created, degraded } = await c.weekly();
  assert.deepEqual(briefing.sources.map(({ sourceId, state }) => [sourceId, state]), [
    ['tasks', 'unavailable'], ['personal:mail', 'unavailable'], ['personal:calendar', 'ok'],
  ]);
  assert.equal(complete, true, 'attempt 3 must complete with a working calendar');
  assert.equal(created, true);
  assert.equal(degraded, true);
  assert.deepEqual(c.latestWeekly(), briefing);
}));

test('a degraded review is upgraded in place once its missing source returns, keeping its identity, and is final after that', () => withGoogle(async rig => {
  await seed(rig);
  rig.fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig);
  for (let i = 0; i < 3; i++) { await c.weekly(); rig.clock.now += 16 * 60_000; }
  const degraded = c.latestWeekly()!;
  assert.ok(degraded.items.some(i => i.reason === 'source_unavailable'));
  rig.fake.failures.clear();
  const upgraded = await c.weekly();
  assert.deepEqual([upgraded.complete, upgraded.created, upgraded.degraded], [true, false, false]);
  assert.equal(upgraded.briefing.briefingId, degraded.briefingId, 'the notification still points at it');
  assert.ok(section(upgraded.briefing, 'agenda').length > 0 && !upgraded.briefing.items.some(i => i.reason === 'source_unavailable'));
  assert.deepEqual(c.latestWeekly(), upgraded.briefing);
  assert.equal(c.weeklyAttempt('2026-11-01'), null, 'cleared once nothing is missing');
  const reads = rig.fake.log.length;
  assert.deepEqual((await c.weekly()).degraded, false);
  assert.equal(rig.fake.log.length, reads, 'a complete review is never read again');
}));

test('a review that stays degraded stops being retried after a few more tries, and the older weeks leave no attempt behind', () => withGoogle(async rig => {
  await seed(rig);
  rig.fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig);
  const degraded: boolean[] = [];
  for (let i = 0; i < 9; i++) { degraded.push((await c.weekly()).degraded); rig.clock.now += 16 * 60_000; }
  assert.deepEqual(degraded, [false, false, true, true, true, true, false, false, false]);
  assert.equal(c.weeklyAttempt('2026-11-01')?.tries, 7, 'the attempt stays as the proof that it is final');
  const reads = rig.fake.log.length;
  await c.weekly();
  assert.equal(rig.fake.log.length, reads, 'a final degraded review is not read again');
  rig.clock.now = Date.parse('2026-11-08T21:30:00.000Z');
  await c.weekly('2026-11-08');
  assert.equal(c.weeklyAttempt('2026-11-01'), null);
}));

test('an unexpected failure is not counted as an unavailable source, so it never degrades a review early', () => withGoogle(async rig => {
  await seed(rig);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig);
  const internals = c as unknown as { assemble: () => never };
  const assemble = internals.assemble;
  internals.assemble = () => { throw new Error('store_down'); };
  for (let i = 0; i < 3; i++) { await assert.rejects(c.weekly(), /store_down/); rig.clock.now += 16 * 60_000; }
  assert.equal(c.weeklyAttempt('2026-11-01')?.tries, 0, 'three exceptions burned nothing');
  assert.ok(c.weeklyAttempt('2026-11-01')!.at > 0, 'but the retry delay still applies');
  internals.assemble = assemble;
  rig.fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  assert.equal((await c.weekly()).complete, false, 'the first unavailable source is still only the first try');
  assert.equal(c.latestWeekly(), null);
}));

test('an unavailable task store is named as missing, not as a calendar or mail', () => withGoogle(async rig => {
  await seed(rig);
  rig.clock.now = SUNDAY_EVENING;
  rig.store.list = () => { throw new Error('store_down'); };
  const c = composer(rig);
  for (let i = 0; i < 3; i++) { await c.weekly(); rig.clock.now += 16 * 60_000; }
  const missing = c.latestWeekly()!.items.filter(i => i.reason === 'source_unavailable');
  assert.deepEqual(missing.map(i => [i.section, i.title]), [['tasks', 'tasks is unavailable: not included in this review']]);
}));

test('an exception before the review is stored counts as a failed attempt, apart from the tries that degrade a review', () => withGoogle(async rig => {
  await seed(rig);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig);
  (c as unknown as { assemble: () => never }).assemble = () => { throw new Error('boom'); };
  for (let i = 0; i < 3; i++) { await assert.rejects(c.weekly(), /boom/); rig.clock.now += 16 * 60_000; }
  assert.deepEqual(c.weeklyAttempt('2026-11-01') && [c.weeklyAttempt('2026-11-01')!.tries, c.weeklyAttempt('2026-11-01')!.failures], [0, 3]);
}));

test('a stored degraded review whose re-reads keep failing with an exception stops being re-read after the same few tries', () => withGoogle(async rig => {
  await seed(rig);
  rig.fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig);
  for (let i = 0; i < 3; i++) { await c.weekly(); rig.clock.now += 16 * 60_000; }
  assert.equal(c.weeklyAttempt('2026-11-01')?.tries, 3);
  (c as unknown as { assemble: () => never }).assemble = () => { throw new Error('boom'); };
  const outcomes: string[] = [];
  const reads: number[] = [];
  for (let i = 0; i < 6; i++) {
    outcomes.push(await c.weekly().then(r => String(r.degraded), error => (error as Error).message));
    reads.push(rig.fake.log.length);
    rig.clock.now += 16 * 60_000;
  }
  assert.deepEqual(outcomes, ['boom', 'boom', 'boom', 'boom', 'false', 'false']);
  assert.equal(reads[3], reads[5], 'no read after the limit');
}));
