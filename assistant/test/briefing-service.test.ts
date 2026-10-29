import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { GoogleLocal } from '../src/connectors/google-local.ts';
import { BriefingService } from '../src/briefing/service.ts';
import { createAssistantServer } from '../src/http/server.ts';
import { TaskStore } from '../src/store/db.ts';
import { ACCOUNTS, CLIENT_ID, CLIENT_SECRET, FakeGoogle } from './google-support.ts';
import { memoryProtector, privateDir } from './vault-support.ts';

const REAL_ID = CLIENT_ID.replace(/\.test$/, '.com');
const TZ = 'America/Sao_Paulo';

/** A connected 'personal' account on the fake Google, with a clock the test moves. */
async function rig(fn: (r: { dir: string; fake: FakeGoogle; clock: { now: number }; local: () => Promise<GoogleLocal> }) => Promise<void>) {
  await privateDir('briefing-service-', async dir => {
    const clock = { now: Date.parse('2026-10-28T09:00:00.000Z') }; // 06:00 in São Paulo
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

  clock.now = Date.parse('2026-10-28T10:30:00.000Z'); // 07:30
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
