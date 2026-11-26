import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withGoogle } from './google-support.ts';
import { SUNDAY_EVENING, composer, section, seed } from './weekly-support.ts';

test('the weekly review lists open tasks, threads still waiting for the user, and next week with conflicts and back-to-back meetings flagged', () => withGoogle(async rig => {
  await seed(rig);
  rig.clock.now = SUNDAY_EVENING;
  const { briefing, created } = await composer(rig).weekly();
  assert.equal(created, true);
  assert.equal(briefing.kind, 'weekly');
  assert.equal(briefing.localDate, '2026-11-01');
  assert.deepEqual(briefing.sources.map(s => [s.sourceId, s.state]), [['tasks', 'ok'], ['personal:mail', 'ok'], ['personal:calendar', 'ok'], ['dentai:mail', 'ok'], ['dentai:calendar', 'ok']]);

  assert.deepEqual(section(briefing, 'tasks').map(i => [i.title, i.reason]), [['Send the invoice', 'needs_input']], 'only open tasks');
  assert.deepEqual(section(briefing, 'messages').map(i => [i.sourceRef, i.reason]).sort(), [
    ['gmail:dentai:d1', 'awaiting_reply'], ['gmail:personal:e2', 'awaiting_reply'], ['gmail:personal:w1', 'awaiting_reply'],
  ], 'a thread answered from Sent (not in the mail list), promotions and mail older than the week are not waiting; a newer message after the reply is');
  assert.ok(section(briefing, 'messages').every(i => i.untrusted && !i.startable));
  assert.match(section(briefing, 'messages').find(i => i.sourceRef.endsWith(':w1'))!.title, /ana@example\.test/, 'who is waiting is named');

  const agenda = section(briefing, 'agenda');
  assert.deepEqual(agenda.map(i => [i.title.replace(/^\S+ \S+ /, ''), i.reason, i.urgency]), [
    ['Planning', 'conflict', 'urgent'], ['Client call', 'conflict', 'urgent'], ['Retro', 'conflict', 'urgent'], ['Retro', 'conflict', 'urgent'], ['Standup', 'conflict', 'urgent'], ['Standup', 'conflict', 'urgent'],
    ['Review', 'back_to_back', 'normal'], ['Lunch', 'back_to_back', 'normal'], ['Sync', 'back_to_back', 'normal'], ['Dentist', 'event', 'normal'], ['Offsite', 'event', 'normal'],
  ], 'conflicts first, then by time; the same invitation (same iCalUID) on both calendars counts once, homonymous meetings with different invitations on two calendars stay, two distinct events with the same title and time on one calendar both stay, a copy without an iCalUID on both calendars counts once by time and title and fakes no conflict, and the week after is out of range');
  assert.match(agenda[0].title, /^2026-11-02 09:00 Planning$/);
  assert.ok(agenda.every(i => i.untrusted && !i.startable));
}));

test('one weekly review per local date, kept out of the daily line and the latest briefing', () => withGoogle(async rig => {
  await seed(rig);
  rig.clock.now = SUNDAY_EVENING;
  const c = composer(rig);
  const first = await c.weekly();
  const reads = rig.fake.log.length;
  rig.clock.now += 20 * 60_000;
  const again = await c.weekly();
  assert.equal(again.created, false);
  assert.equal(again.briefing.briefingId, first.briefing.briefingId);
  assert.equal(rig.fake.log.length, reads, 'an existing review is returned without reading Google again');
  assert.equal(c.latest(), null, 'the weekly review is not the latest daily or on-demand briefing');
  assert.equal(c.latestWeekly()?.briefingId, first.briefing.briefingId);

  const daily = await c.daily();
  assert.equal(daily.kind, 'daily');
  assert.deepEqual(section(daily, 'changes'), [], 'the weekly review is not the baseline for what changed since the last briefing');
  assert.equal(c.latest()?.briefingId, daily.briefingId);
}));
