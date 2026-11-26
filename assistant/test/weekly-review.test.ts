import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BriefingComposer, type Briefing } from '../src/briefing/compose.ts';
import type { Event } from '../src/contracts/events.ts';
import type { Task } from '../src/contracts/tasks.ts';
import { withGoogle, type GoogleRig } from './google-support.ts';

const TZ = 'America/Sao_Paulo';
/** Sunday 2026-11-01, 18:30 in Sao Paulo. */
const SUNDAY_EVENING = Date.parse('2026-11-01T21:30:00.000Z');
const rules = { trustedSenders: ['boss@dentai.example.test'] };

function composer(rig: GoogleRig) {
  const c = new BriefingComposer({ databasePath: rig.databasePath, profileId: 'p', operatorAuthority: rig.authority, timeZone: TZ, store: rig.store, google: rig.google, connections: ['personal', 'dentai'], rules, now: () => rig.clock.now });
  rig.defer(() => c.close());
  return c;
}
const event = (id: string, summary: string, start: string, end: string) => ({ id, summary, status: 'confirmed', updated: '2026-10-01T00:00:00.000Z', start: { dateTime: start }, end: { dateTime: end } });
const section = (b: Briefing, name: string) => b.items.filter(i => i.section === name);

function openTask(rig: GoogleRig, taskId: string, title: string, status: Task['status']) {
  const task: Task = { version: 1, profileId: 'p', taskId, title, status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: taskId };
  const e = (id: string): Event => ({ version: 1, eventId: id, profileId: 'p', sessionId: 's', channelId: 'c', taskId, runId: 'r', source: { actorId: 'lucas', sourceKind: 'trusted-local-human', sourceEventId: id === `e-${taskId}` ? taskId : id }, observedAt: '2026-10-30T10:00:00.000Z', sequence: rig.store.nextSequence(), correlationId: 'c', evidence: { kind: 'observed', reference: 'test' } });
  rig.store.create(task, e(`e-${taskId}`));
  rig.store.transition(taskId, 1, 'working', e(`e2-${taskId}`));
  rig.store.transition(taskId, 2, status, e(`e3-${taskId}`));
}

async function seed(rig: GoogleRig) {
  await rig.connect('personal', 'personal');
  await rig.connect('dentai', 'dentai');
  openTask(rig, 't-open', 'Send the invoice', 'needs_input');
  openTask(rig, 't-done', 'Already finished', 'succeeded');
  rig.fake.mail.personal.push(
    { id: 'w1', from: 'Ana <ana@example.test>', subject: 'Proposal for review', body: 'Can you look?', receivedAt: '2026-10-30T12:00:00.000Z' },
    { id: 'w2', from: 'Bob <bob@example.test>', subject: 'Lunch?', body: 'Thursday?', threadId: 'thread-bob', receivedAt: '2026-10-29T12:00:00.000Z' },
    { id: 'w2-reply', from: 'Me <me@example.test>', subject: 'Re: Lunch?', body: 'Sure', labels: ['SENT'], threadId: 'thread-bob', receivedAt: '2026-10-30T09:00:00.000Z' },
    { id: 'promo', from: 'Deals <deals@shop.example.test>', subject: 'Flash sale', body: 'Unsubscribe', labels: ['CATEGORY_PROMOTIONS'], receivedAt: '2026-10-31T08:00:00.000Z' },
    { id: 'old', from: 'Old <old@example.test>', subject: 'Eight days ago', body: 'Hello', receivedAt: '2026-10-23T12:00:00.000Z' },
  );
  rig.fake.mail.dentai.push({ id: 'd1', from: 'Rita <boss@dentai.example.test>', subject: 'Sign the contract today', body: 'Please.', receivedAt: '2026-10-31T10:00:00.000Z' });
  rig.fake.events.personal.push(
    event('planning', 'Planning', '2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z'),
    event('review', 'Review', '2026-11-02T13:30:00Z', '2026-11-02T14:00:00Z'),
    event('lunch', 'Lunch', '2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'),
    event('sync', 'Sync', '2026-11-03T16:00:00Z', '2026-11-03T16:30:00Z'),
    event('alone', 'Dentist', '2026-11-05T18:00:00Z', '2026-11-05T19:00:00Z'),
    event('later', 'The week after', '2026-11-09T15:00:00Z', '2026-11-09T16:00:00Z'),
  );
  rig.fake.events.dentai.push(
    event('call', 'Client call', '2026-11-02T12:30:00Z', '2026-11-02T13:30:00Z'),
    event('planning-copy', 'Planning', '2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z'),
  );
}

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
    ['gmail:dentai:d1', 'awaiting_reply'], ['gmail:personal:w1', 'awaiting_reply'],
  ], 'a replied thread, promotions and mail older than the week are not waiting');
  assert.ok(section(briefing, 'messages').every(i => i.untrusted && !i.startable));
  assert.match(section(briefing, 'messages').find(i => i.sourceRef.endsWith(':w1'))!.title, /ana@example\.test/, 'who is waiting is named');

  const agenda = section(briefing, 'agenda');
  assert.deepEqual(agenda.map(i => [i.title.replace(/^\S+ \S+ /, ''), i.reason, i.urgency]), [
    ['Planning', 'conflict', 'urgent'], ['Client call', 'conflict', 'urgent'],
    ['Review', 'back_to_back', 'normal'], ['Lunch', 'back_to_back', 'normal'], ['Sync', 'back_to_back', 'normal'], ['Dentist', 'event', 'normal'],
  ], 'conflicts first, then by time; a meeting copied on both calendars counts once and the week after is out of range');
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

test('a source that fails is listed, and the rest of the review still arrives', () => withGoogle(async rig => {
  await seed(rig);
  rig.fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  rig.clock.now = SUNDAY_EVENING;
  const { briefing } = await composer(rig).weekly();
  assert.equal(briefing.sources.find(s => s.sourceId === 'personal:calendar')?.state, 'unavailable');
  assert.equal(section(briefing, 'agenda').length, 0);
  assert.equal(section(briefing, 'messages').length, 2);
}));
