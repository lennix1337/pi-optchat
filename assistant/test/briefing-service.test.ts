import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { GoogleLocal } from '../src/connectors/google-local.ts';
import { BriefingService } from '../src/briefing/service.ts';
import { weeklySchedule } from '../src/briefing/weekly.ts';
import { BriefingComposer, type Briefing } from '../src/briefing/compose.ts';
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

const sunday = (hhmmZ: string, date = '2026-11-01') => Date.parse(`${date}T${hhmmZ}:00.000Z`);

test('weekly review: nothing without opt-in; with it exactly one review per week, on the configured local day after the hour, kept across restarts', () => rig(async ({ fake, clock, local }) => {
  fake.mail.personal.push({ id: 'w1', from: 'Ana <ana@example.test>', subject: 'Proposal', body: 'Can you look?', receivedAt: '2026-10-30T12:00:00.000Z' });
  fake.events.personal.push({ id: 'a', summary: 'A', status: 'confirmed', start: { dateTime: '2026-11-02T12:00:00Z' }, end: { dateTime: '2026-11-02T13:00:00Z' } });
  const sent: Briefing[] = [];
  const make = async (weekly = true) => new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '07:00', now: () => clock.now, ...(weekly ? { weekly: { day: 0, at: '18:00' } } : {}), onWeekly: b => sent.push(b) });

  clock.now = sunday('21:30');
  assert.equal(await (await make(false)).weeklyTick(), null, 'weekly is opt-in');
  assert.equal(gmailReads(fake), 0);

  const service = await make();
  clock.now = sunday('01:30');
  assert.equal(await service.weeklyTick(), null, 'Saturday 22:30 in Sao Paulo: a first review waits for its own boundary and does not look back');
  clock.now = sunday('20:59');
  assert.equal(await service.weeklyTick(), null, 'Sunday 17:59 is before the hour');
  assert.equal(gmailReads(fake), 0);

  clock.now = sunday('21:00');
  const review = await service.weeklyTick();
  assert.equal(review?.kind, 'weekly');
  assert.equal(review?.localDate, '2026-11-01');
  assert.equal(sent.length, 1);
  assert.ok(review!.items.some(i => i.section === 'messages' && i.sourceRef.endsWith(':w1')), JSON.stringify(review!.items));
  assert.ok(review!.items.some(i => i.section === 'agenda'), 'next week agenda is read');
  const reads = gmailReads(fake);
  clock.now = sunday('23:50');
  assert.equal(await service.weeklyTick(), null, 'already sent this week');
  assert.equal(await (await make()).weeklyTick(), null, 'a restart the same evening does not send again');
  assert.equal(gmailReads(fake), reads, 'nor read Google again');
  assert.equal(sent.length, 1);
  assert.equal((await service.latestWeekly())?.briefingId, review!.briefingId);
  assert.equal(await service.latest(), null, 'the weekly review is not the daily briefing');

  clock.now = sunday('21:00', '2026-11-02');
  assert.equal(await service.weeklyTick(), null, 'Monday is not the day');
  clock.now = sunday('21:00', '2026-11-08');
  const next = await service.weeklyTick();
  assert.equal(next?.localDate, '2026-11-08');
  assert.equal(sent.length, 2, 'one send per week');
}));

test('weekly review: a week the service missed is recovered on the next tick, once, until the next cycle starts', () => rig(async ({ fake, clock, local }) => {
  fake.mail.personal.push({ id: 'w1', from: 'Ana <ana@example.test>', subject: 'Proposal', body: 'Can you look?', receivedAt: '2026-10-30T12:00:00.000Z' });
  const sent: Briefing[] = [];
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '07:00', now: () => clock.now, weekly: { day: 0, at: '18:00' }, onWeekly: b => sent.push(b) });
  clock.now = sunday('21:00', '2026-10-25');
  assert.equal((await service.weeklyTick())?.localDate, '2026-10-25');
  clock.now = sunday('12:00', '2026-11-03');
  const recovered = await service.weeklyTick();
  assert.equal(recovered?.localDate, '2026-11-01', 'Tuesday recovers the Sunday the service was not running for');
  assert.equal(sent.length, 2);
  clock.now = sunday('12:00', '2026-11-04');
  assert.equal(await service.weeklyTick(), null, 'only once');
  clock.now = sunday('20:59', '2026-11-08');
  assert.equal(await service.weeklyTick(), null, 'still the same cycle before the next boundary');
  clock.now = sunday('21:00', '2026-11-08');
  assert.equal((await service.weeklyTick())?.localDate, '2026-11-08');
  assert.equal(sent.length, 3);
}));

test('weekly review: a source that fails keeps the week open: nothing is stored or announced, retries are spaced, and the complete review is sent once', () => rig(async ({ fake, clock, local }) => {
  fake.mail.personal.push({ id: 'w1', from: 'Ana <ana@example.test>', subject: 'Proposal', body: 'Can you look?', receivedAt: '2026-10-30T12:00:00.000Z' });
  const sent: Briefing[] = [];
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '07:00', now: () => clock.now, weekly: { day: 0, at: '18:00' }, onWeekly: b => sent.push(b) });
  fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  clock.now = sunday('21:00');
  await assert.rejects(service.weeklyTick(), /weekly_review_incomplete/);
  assert.deepEqual([sent.length, await service.latestWeekly()], [0, null]);
  const reads = fake.log.length;
  clock.now += 60_000;
  assert.equal(await service.weeklyTick(), null, 'a retry a minute later waits');
  assert.equal(fake.log.length, reads, 'and does not hit Google');
  fake.failures.clear();
  clock.now += 20 * 60_000;
  const review = await service.weeklyTick();
  assert.deepEqual(review?.sources.map(s => s.state), ['ok', 'ok', 'ok']);
  assert.equal(sent.length, 1);
  clock.now += 60_000;
  assert.equal(await service.weeklyTick(), null);
  assert.equal(sent.length, 1);
}));

test('weekly review: a degraded review is announced once, upgraded when its source returns, and never announced again', () => rig(async ({ fake, clock, local }) => {
  fake.mail.personal.push({ id: 'w1', from: 'Ana <ana@example.test>', subject: 'Proposal', body: 'Can you look?', receivedAt: '2026-10-30T12:00:00.000Z' });
  const sent: Briefing[] = [];
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '07:00', now: () => clock.now, weekly: { day: 0, at: '18:00' }, onWeekly: b => sent.push(b) });
  fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  clock.now = sunday('21:00');
  await assert.rejects(service.weeklyTick(), /weekly_review_incomplete/);
  clock.now += 16 * 60_000;
  await assert.rejects(service.weeklyTick(), /weekly_review_incomplete/);
  clock.now += 16 * 60_000;
  const degraded = await service.weeklyTick();
  assert.deepEqual([sent.length, degraded?.sources.filter(s => s.state === 'unavailable').length], [1, 1]);
  clock.now += 60_000;
  const reads = fake.log.length;
  assert.equal(await service.weeklyTick(), null, 'the next minute waits');
  assert.equal(fake.log.length, reads);
  fake.failures.clear();
  clock.now += 16 * 60_000;
  assert.equal(await service.weeklyTick(), null, 'the upgrade is not announced again');
  const upgraded = (await service.latestWeekly())!;
  assert.deepEqual([upgraded.briefingId, upgraded.sources.map(s => s.state)], [degraded!.briefingId, ['ok', 'ok', 'ok']]);
  assert.equal(sent.length, 1);
  const done = fake.log.length;
  clock.now += 16 * 60_000;
  assert.equal(await service.weeklyTick(), null);
  assert.equal(fake.log.length, done, 'and a complete review is not read again');
}));

test('weekly review: a failure that repeats before the review is stored is retried a few times, then given up for the week', () => rig(async ({ fake, clock, local }) => {
  const sent: Briefing[] = [];
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '07:00', now: () => clock.now, weekly: { day: 0, at: '18:00' }, onWeekly: b => sent.push(b) });
  const proto = BriefingComposer.prototype as unknown as { assemble: () => never };
  const assemble = proto.assemble;
  proto.assemble = () => { throw new Error('boom'); };
  try {
    clock.now = sunday('21:00');
    const outcomes: string[] = [];
    const reads: number[] = [];
    for (let i = 0; i < 9; i++) {
      outcomes.push(await service.weeklyTick().then(() => 'quiet', error => (error as Error).message));
      reads.push(fake.log.length);
      clock.now += 16 * 60_000;
    }
    assert.deepEqual(outcomes, ['boom', 'boom', 'boom', 'boom', 'boom', 'boom', 'quiet', 'quiet', 'quiet']);
    assert.equal(reads[5], reads[8], 'nothing is read after the sixth failure');
    assert.equal(sent.length, 0);
  } finally { proto.assemble = assemble; }
}));

test('weekly review: the retry delay survives a restart: a new service does not read Google again until it is over', () => rig(async ({ fake, clock, local }) => {
  fake.mail.personal.push({ id: 'w1', from: 'Ana <ana@example.test>', subject: 'Proposal', body: 'Can you look?', receivedAt: '2026-10-30T12:00:00.000Z' });
  const sent: Briefing[] = [];
  const make = async () => new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '07:00', now: () => clock.now, weekly: { day: 0, at: '18:00' }, onWeekly: b => sent.push(b) });
  fake.failures.set('/calendar/v3/calendars/primary/events', 500);
  clock.now = sunday('21:00');
  await assert.rejects((await make()).weeklyTick(), /weekly_review_incomplete/);
  const reads = fake.log.length;
  clock.now += 60_000;
  assert.equal(await (await make()).weeklyTick(), null, 'a restart one minute later waits');
  assert.equal(fake.log.length, reads, 'and does not hit Google');
  fake.failures.clear();
  clock.now += 20 * 60_000;
  assert.equal((await (await make()).weeklyTick())?.kind, 'weekly');
  assert.equal(sent.length, 1);
}));

test('weekly review: the background loop sends it, and the schedule defaults to Sunday evening', () => rig(async ({ clock, local }) => {
  clock.now = sunday('21:10');
  const sent = Promise.withResolvers<Briefing>();
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '23:59', now: () => clock.now, weekly: weeklySchedule(true), onWeekly: b => sent.resolve(b) });
  service.start(3_600_000, error => sent.reject(error));
  try { assert.equal((await sent.promise).kind, 'weekly'); } finally { service.stop(); }
  assert.deepEqual(weeklySchedule(true), { day: 0, at: '18:00' });
  assert.deepEqual(weeklySchedule({ day: 'fri' }), { day: 5, at: '18:00' });
  assert.deepEqual(weeklySchedule({ at: '20:30' }), { day: 0, at: '20:30' });
  assert.equal(weeklySchedule(undefined), undefined);
  assert.throws(() => weeklySchedule({ day: 'funday' }), /invalid_options/);
  assert.throws(() => weeklySchedule({ at: '6pm' }), /invalid_options/);
}));

test('HTTP: GET /v1/briefing?kind=weekly returns the stored weekly review, and no other kind is accepted', () => rig(async ({ dir, clock, local }) => {
  clock.now = sunday('21:10');
  const service = new BriefingService({ local: await local(), connections: ['personal'], timeZone: TZ, dailyAt: '07:00', now: () => clock.now, weekly: { day: 0, at: '18:00' } });
  const store = new TaskStore(join(dir, 'tasks.sqlite'), 'p');
  const server = createAssistantServer({ store, token: 't', profileId: 'p', briefings: service });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const get = (query: string) => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/briefing${query}`, { headers: { authorization: 'Bearer t' } });
  try {
    assert.equal((await get('?kind=weekly')).status, 404, 'none yet');
    const review = await service.weeklyTick();
    const found = await get('?kind=weekly');
    assert.equal(found.status, 200);
    assert.equal((await found.json() as { briefingId: string }).briefingId, review!.briefingId);
    assert.equal((await get('')).status, 404, 'the plain route is still the daily briefing');
    assert.equal((await get('?kind=daily')).status, 400);
  } finally { server.closeAllConnections(); server.close(); store.close(); }
}));
