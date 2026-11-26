import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { GoogleLocal } from '../src/connectors/google-local.ts';
import { BriefingService } from '../src/briefing/service.ts';
import type { MeetingPrepCard } from '../src/briefing/meeting-prep.ts';
import { createNotificationCenter } from '../src/notifications/center.ts';
import { createAssistantServer } from '../src/http/server.ts';
import { TaskStore } from '../src/store/db.ts';
import { ACCOUNTS, CLIENT_ID, CLIENT_SECRET, FakeGoogle } from './google-support.ts';
import { memoryProtector, privateDir } from './vault-support.ts';

const REAL_ID = CLIENT_ID.replace(/\.test$/, '.com');
const TZ = 'America/Sao_Paulo';


async function rig(fn: (r: { dir: string; fake: FakeGoogle; clock: { now: number }; local: () => Promise<GoogleLocal> }) => Promise<void>) {
  await privateDir('briefing-service-', async dir => {
    const clock = { now: Date.parse('2026-10-28T09:00:00.000Z') };
    const fake = new FakeGoogle(clock);
    fake.clientId = REAL_ID;
    await fake.start();
    const { protector } = memoryProtector();
    const opened: GoogleLocal[] = [];
    const local = async () => {
      const l = await GoogleLocal.open({ databasePath: join(dir, 'tasks.sqlite'), profileId: 'p', protector, endpoints: fake.endpoints, now: () => clock.now });
      opened.push(l);
      return l;
    };
    try {
      const setup = await local();
      setup.setClient(JSON.stringify({ installed: { client_id: REAL_ID, client_secret: CLIENT_SECRET } }));
      let page: Promise<Response> | undefined;
      await setup.connect({ name: 'personal', email: ACCOUNTS.personal.email, onUrl: url => {
        fake.redirectUris.add(new URL(url).searchParams.get('redirect_uri')!);
        page = fetch(fake.consent(url, 'personal'));
      } });
      assert.equal((await page!).status, 200);
      await fn({ dir, fake, clock, local });
    } finally { for (const l of opened) l.close(); await fake.close(); }
  });
}

const gmailReads = (fake: FakeGoogle) => fake.log.filter(entry => entry.path.startsWith('/gmail/')).length;

const meeting = (id: string, summary: string, start: string, attendees: { email: string; displayName?: string; self?: boolean }[]) => ({
  id, summary, start: { dateTime: start }, end: { dateTime: new Date(Date.parse(start) + 3_600_000).toISOString() }, attendees,
});
const guest = { email: 'robin@example.test', displayName: 'Robin' };

test('daily briefing includes ordered 24-hour prep cards with relevant threads and open items', async () => rig(async ({ fake, clock, local }) => {
  fake.events.personal.push(
    meeting('later', 'Project Quartz', '2026-10-29T08:55:00Z', [guest]),
    meeting('solo', 'Solo', '2026-10-28T10:00:00Z', [{ email: ACCOUNTS.personal.email, self: true }]),
    meeting('early', 'Review Indigo', '2026-10-28T12:00:00Z', [guest, { email: ACCOUNTS.personal.email }]),
    meeting('outside', 'Outside', '2026-10-29T09:00:00Z', [guest]),
    meeting('started', 'Started', '2026-10-28T08:45:00Z', [guest]),
  );
  fake.mail.personal.push(
    { id: 'old', threadId: 'thread-1', from: 'casey@example.test', subject: 'Earlier notes', body: 'Old body', labels: ['UNREAD'], receivedAt: '2026-10-27T11:00:00Z' },
    { id: 'new', threadId: 'thread-1', from: 'owner@example.test', to: `Robin <${guest.email}>`, subject: 'New notes', body: 'This must not reach the card', receivedAt: '2026-10-28T08:45:00Z' },
    { id: 'subject', from: 'casey@example.test', subject: 'Re: Review Indigo', body: 'Review question', labels: ['INBOX', 'UNREAD'], receivedAt: '2026-10-28T08:30:00Z' },
    { id: 'unrelated', from: 'other-robin@example.test', subject: 'Unrelated', body: 'Ignore this fixture', receivedAt: '2026-10-28T08:50:00Z' },
  );
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '06:00', meetingPrep: true, now: () => clock.now });
  const briefing = await service.tick();
  const cards = briefing?.meetingPrep ?? [];
  assert.deepEqual(cards.map(card => card.title), ['Review Indigo', 'Project Quartz']);
  assert.deepEqual(cards[0].attendees, [guest]);
  assert.equal(cards[0].when, '2026-10-28 09:00');
  assert.deepEqual(cards[0].threads.map(thread => thread.subject), ['New notes', 'Re: Review Indigo']);
  assert.deepEqual(cards[0].openItems.map(item => item.title), ['Re: Review Indigo']);
  assert.ok(!JSON.stringify(cards).includes('This must not reach the card'));
  assert.deepEqual((await service.latest())?.meetingPrep, cards);
  assert.equal(fake.requests('/gmail/v1/users/me/messages').filter(r => r.path.endsWith('/messages')).length, 2, 'one paginated mail read');
  assert.ok(fake.log.filter(r => /^\/(gmail|calendar)\//.test(r.path)).every(r => r.method === 'GET'));
}));

test('reminders make their card available once at 30 minutes, independently of the daily brief', async () => rig(async ({ dir, fake, clock, local }) => {
  fake.events.personal.push(
    meeting('upcoming', 'Design review', '2026-10-28T10:00:00Z', [guest]),
    meeting('solo', 'Solo', '2026-10-28T10:05:00Z', []),
    meeting('second', 'Demo', '2026-10-28T10:10:00Z', [guest]),
  );
  fake.mail.personal.push({ id: 'design', from: guest.email, subject: 'Sketch', body: 'Draft', receivedAt: '2026-10-28T08:45:00Z' });
  const center = createNotificationCenter({ databasePath: join(dir, 'notifications.sqlite'), operatorAuthority: {}, now: () => clock.now });
  const ready: MeetingPrepCard[] = [];
  const make = async (meetingPrep: boolean) => new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '12:00', meetingPrep, now: () => clock.now,
    onMeetingPrep: card => { center.notify({ id: card.cardId, ref: card.cardId, channel: 'local', category: 'meeting_prep_ready' }); ready.push(card); },
  });
  try {
    const service = await make(true);
    clock.now = Date.parse('2026-10-28T09:29:59.999Z');
    assert.equal(await service.tick(), null);
    assert.deepEqual(ready, []);
    assert.equal(gmailReads(fake), 0);
    clock.now++;
    await Promise.all([service.tick(), service.tick(), (await make(false)).tick()]);
    assert.deepEqual(ready.map(card => card.title), ['Design review']);
    assert.equal(ready[0].threads[0].subject, 'Sketch');
    const reads = gmailReads(fake);
    await service.tick();
    assert.equal(gmailReads(fake), reads);
    clock.now = Date.parse('2026-10-28T09:40:00Z');
    await service.tick();
    assert.deepEqual(ready.map(card => card.title), ['Design review', 'Demo']);
    assert.equal(await service.latest(), null, 'reminders do not overwrite or advance the daily brief');
    const beforeRestart = gmailReads(fake);
    service.stop();
    await (await make(true)).tick();
    assert.deepEqual(ready.map(card => card.title), ['Design review', 'Demo'], 'the callback is not replayed after restart');
    assert.equal(gmailReads(fake), beforeRestart, 'already announced cards do not need fresh Gmail reads');
    const notices = center.list();
    assert.equal(notices.length, 2, 'same occurrences deduplicate in the notification center after restart');
    assert.ok(notices.every(note => note.category === 'meeting_prep_ready' && note.state === 'pending'));
    assert.ok(!JSON.stringify(notices).includes('Design review'));
  } finally { center.close(); }
}));

test('a fresh daily briefing and its due reminders share one read of each Google source', async () => rig(async ({ fake, clock, local }) => {
  fake.events.personal.push(meeting('due', 'Design review', '2026-10-28T09:30:00Z', [guest]));
  fake.mail.personal.push({ id: 'review', from: guest.email, subject: 'Sketch', body: 'Draft', receivedAt: '2026-10-28T08:45:00Z' });
  const ready: MeetingPrepCard[] = [];
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '06:00', meetingPrep: true,
    now: () => clock.now, onMeetingPrep: card => { ready.push(card); },
  });
  const daily = await service.tick();
  assert.deepEqual(ready, daily?.meetingPrep);
  assert.deepEqual([
    fake.log.filter(r => r.path === '/gmail/v1/users/me/messages').length,
    fake.requests('/calendar/v3/calendars/primary/events').length,
  ], [1, 1]);

  service.stop();
  fake.events.personal[0] = meeting('due', 'Rescheduled design review', '2026-10-28T09:25:00Z', [guest]);
  const restarted = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '06:00', meetingPrep: true,
    now: () => clock.now, onMeetingPrep: card => { ready.push(card); },
  });
  assert.equal((await restarted.tick())?.briefingId, daily?.briefingId, 'restart reuses the stored daily');
  assert.deepEqual(ready.map(card => card.title), ['Design review', 'Rescheduled design review'], 'reminders see changes since the stored daily');
  assert.notEqual(ready[0].cardId, ready[1].cardId, 'a changed start is a new occurrence');
}));

test('a failed reminder callback does not drop the other cards in its tick', async () => rig(async ({ fake, clock, local }) => {
  fake.events.personal.push(
    meeting('first', 'Design review', '2026-10-28T09:15:00Z', [guest]),
    meeting('second', 'Demo', '2026-10-28T09:20:00Z', [guest]),
  );
  const delivered: string[] = [];
  let fail = true;
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '06:00', meetingPrep: true, now: () => clock.now,
    onMeetingPrep: card => { if (fail && card.title === 'Design review') throw new Error('notification_failed'); delivered.push(card.title); },
  });
  await assert.rejects(service.tick(), /notification_failed/);
  assert.deepEqual(delivered, ['Demo']);
  assert.equal((await service.latest())?.kind, 'daily');
  fail = false;
  await service.tick();
  assert.deepEqual(delivered, ['Demo', 'Design review'], 'only the failed card is retried');
}));

test('prep includes active all-day meetings but not ones whose exclusive end is today', async () => rig(async ({ fake, clock, local }) => {
  fake.events.personal.push(
    { id: 'active', summary: 'Design retreat', start: { date: '2026-10-25' }, end: { date: '2026-10-29' }, attendees: [guest] },
    { id: 'ended', summary: 'Previous retreat', start: { date: '2026-10-27' }, end: { date: '2026-10-28' }, attendees: [guest] },
    { id: 'tomorrow', summary: 'Demo day', start: { date: '2026-10-29' }, end: { date: '2026-10-30' }, attendees: [guest] },
  );
  const ready: MeetingPrepCard[] = [];
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '06:00', meetingPrep: true, now: () => clock.now,
    onMeetingPrep: card => { ready.push(card); },
  });
  const daily = await service.tick();
  assert.deepEqual(daily?.meetingPrep?.map(card => card.title), ['Design retreat', 'Demo day']);
  assert.deepEqual(daily?.items.filter(item => item.section === 'agenda').map(item => item.title), ['All day Design retreat']);
  assert.deepEqual(ready, [], 'all-day cards never emit timed reminders');
}));

test('the service reads mail and agenda once a day at dailyAt, and a restart the same day does not read again', async () => rig(async ({ fake, clock, local }) => {
  fake.mail.personal.push({ id: 'm1', from: 'Ana <ana@example.test>', subject: 'Reunião amanhã', body: 'Pode confirmar?', receivedAt: '2026-10-28T08:00:00.000Z' });
  const ready: string[] = [];
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '07:00', now: () => clock.now, onReady: b => ready.push(b.briefingId) });
  assert.equal(await service.tick(), null, 'before 07:00 nothing is read');
  assert.equal(gmailReads(fake), 0);
  assert.equal(await service.latest(), null);

  clock.now = Date.parse('2026-10-28T10:30:00.000Z');
  const daily = await service.tick();
  assert.equal(daily?.kind, 'daily');
  assert.equal(daily?.meetingPrep, undefined, 'omitting the opt-in leaves the stored shape unchanged');
  assert.ok(daily!.sources.some(s => s.sourceId === 'personal:mail' && s.state === 'ok'), JSON.stringify(daily!.sources));
  assert.ok(daily!.items.some(i => i.sourceRef.includes('m1') && i.untrusted), JSON.stringify(daily!.items));
  const reads = gmailReads(fake);
  assert.ok(reads > 0);
  assert.equal(await service.tick(), null, 'already read today');
  assert.deepEqual(ready, [daily!.briefingId]);

  const restarted = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '07:00', now: () => clock.now, onReady: b => ready.push(b.briefingId) });
  assert.equal((await restarted.tick())?.briefingId, daily!.briefingId, 'the stored daily briefing is reused');
  assert.equal(gmailReads(fake), reads, 'a restart does not read Google again');
  assert.equal((await restarted.latest())?.briefingId, daily!.briefingId);

  clock.now = Date.parse('2026-10-29T10:30:00.000Z');
  const next = await restarted.tick();
  assert.equal(next?.localDate, '2026-10-29');
  assert.ok(gmailReads(fake) > reads, 'a new day reads again');
}));

test('refresh reads now, concurrent refreshes share one read, and latest is the newest briefing', async () => rig(async ({ fake, clock, local }) => {
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '07:00', now: () => clock.now });
  const [a, b] = await Promise.all([service.refresh(), service.refresh()]);
  assert.equal(a.briefingId, b.briefingId);
  assert.equal(a.kind, 'on_demand');
  const reads = fake.log.filter(entry => entry.path === '/gmail/v1/users/me/messages').length;
  assert.equal(reads, 1, 'one mail listing for two concurrent requests');
  assert.equal((await service.latest())?.briefingId, a.briefingId);
}));

test('HTTP: GET /v1/briefing returns the latest, POST makes one now; both need the token, and no provider is 404', async () => rig(async ({ dir, clock, local }) => {
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '07:00', now: () => clock.now });
  const store = new TaskStore(join(dir, 'tasks.sqlite'), 'p');
  const servers = [createAssistantServer({ store, token: 't', profileId: 'p', briefings: service }), createAssistantServer({ store, token: 't', profileId: 'p' })];
  const bases: string[] = [];
  for (const server of servers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); bases.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
  const call = (base: string, method: string, auth = 'Bearer t') => fetch(`${base}/v1/briefing`, { method, headers: { authorization: auth, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) });
  try {
    assert.equal((await call(bases[0], 'GET', 'Bearer wrong')).status, 401);
    assert.equal((await call(bases[0], 'GET')).status, 404, 'nothing read yet');
    const made = await call(bases[0], 'POST');
    assert.equal(made.status, 200);
    const briefing = await made.json() as { briefingId: string; kind: string };
    assert.equal(briefing.kind, 'on_demand');
    const latest = await call(bases[0], 'GET');
    assert.equal(latest.status, 200);
    assert.equal((await latest.json() as { briefingId: string }).briefingId, briefing.briefingId);
    assert.equal((await call(bases[1], 'GET')).status, 404, 'a service without Google has no briefing');
    assert.equal((await call(bases[1], 'POST')).status, 404);
  } finally {
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    store.close();
  }
}));
