import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withGoogle } from './google-support.ts';
import { SUNDAY_EVENING, composer, section, seed } from './weekly-support.ts';

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
  assert.equal(c.weeklyAttempt('2026-11-01'), null, 'cleared after the save');
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
