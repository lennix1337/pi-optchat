import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleLocal, parseClientJson } from '../src/connectors/google-local.ts';
import { TaskStore } from '../src/store/db.ts';
import { ACCOUNTS, CLIENT_ID, CLIENT_SECRET, FakeGoogle, TOKEN_CANARY, type AccountKey } from './google-support.ts';
import { contains, memoryProtector, privateDir } from './vault-support.ts';

async function rig(fn: (r: { dir: string; fake: FakeGoogle; local: () => Promise<GoogleLocal>; consent: (url: string, account: AccountKey) => Promise<Response> }) => Promise<void>) {
  await privateDir('google-local-', async dir => {
    const clock = { now: Date.parse('2026-10-28T12:00:00.000Z') };
    const fake = new FakeGoogle(clock);
    await fake.start();
    const { protector } = memoryProtector();
    const opened: GoogleLocal[] = [];
    const local = async () => {
      const l = await GoogleLocal.open({ databasePath: join(dir, 'tasks.sqlite'), profileId: 'p', protector, endpoints: fake.endpoints, now: () => clock.now });
      opened.push(l);
      return l;
    };
    // The browser: Google redirects to whatever loopback port the CLI chose, and the browser follows that redirect.
    const consent = async (url: string, account: AccountKey) => {
      fake.redirectUris.add(new URL(url).searchParams.get('redirect_uri')!);
      return fetch(fake.consent(url, account));
    };
    try { await fn({ dir, fake, local, consent }); } finally { for (const l of opened) l.close(); await fake.close(); }
  });
}

// The fixture client id ends in .test; the parser accepts only Google's real suffix, so the fake is told the real one.
const REAL_ID = CLIENT_ID.replace(/\.test$/, '.com');

test('client JSON: only a Google installed-app client is accepted', () => {
  assert.deepEqual(parseClientJson(JSON.stringify({ installed: { client_id: REAL_ID, client_secret: 'GOCSPX-abc_1' } })), { clientId: REAL_ID, clientSecret: 'GOCSPX-abc_1' });
  for (const bad of ['{', '{}', JSON.stringify({ web: { client_id: REAL_ID, client_secret: 'x' } }), JSON.stringify({ installed: { client_id: 'evil.example.com', client_secret: 'x' } }),
    JSON.stringify({ installed: { client_id: REAL_ID, client_secret: 'a b' } })]) assert.throws(() => parseClientJson(bad), /google_client_invalid/);
});

test('journey: client setup -> consent through the loopback callback -> briefing with sources -> Start -> one task; secrets stay in the vault', async () => rig(async ({ dir, fake, local, consent }) => {
  fake.clientId = REAL_ID;
  const l = await local();
  assert.deepEqual(l.list(), [], 'no client, no connections');
  await assert.rejects(l.connect({ name: 'personal', email: ACCOUNTS.personal.email, onUrl: () => {} }), /google_client_missing/);
  l.setClient(JSON.stringify({ installed: { client_id: REAL_ID, client_secret: CLIENT_SECRET } }));

  let page: Promise<Response> | undefined;
  const connection = await l.connect({ name: 'personal', email: ACCOUNTS.personal.email, onUrl: url => { page = consent(url, 'personal'); } });
  assert.equal(connection.email, ACCOUNTS.personal.email);
  const reply = await page!;
  assert.equal(reply.status, 200);
  assert.match(await reply.text(), /Conta conectada/);
  assert.deepEqual(l.list().map(c => [c.connectionId, c.state]), [['personal', 'active']]);

  fake.mail.personal.push({ id: 'm1', from: 'Ana <ana@example.test>', subject: 'Reunião amanhã', body: 'Pode confirmar?', receivedAt: '2026-10-28T10:00:00.000Z' });
  const briefing = await l.briefing(['personal'], 'America/Sao_Paulo');
  assert.ok(briefing.sources.every(s => s.state === 'ok'), JSON.stringify(briefing.sources));
  const item = briefing.items.find(i => i.startable && i.sourceRef.includes('m1'));
  assert.ok(item, JSON.stringify(briefing.items));
  const task = await l.start(briefing.briefingId, item!.itemId, ['personal'], 'America/Sao_Paulo');
  assert.equal(task.status, 'queued');
  assert.deepEqual(await l.start(briefing.briefingId, item!.itemId, ['personal'], 'America/Sao_Paulo'), task, 'a second Start is the same task');
  const store = new TaskStore(join(dir, 'tasks.sqlite'), 'p');
  try { assert.equal(store.get(task.taskId)?.taskId, task.taskId); } finally { store.close(); }

  for (const name of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, name));
    assert.equal(contains(bytes, TOKEN_CANARY), false, `${name} holds no plaintext token`);
    assert.equal(contains(bytes, CLIENT_SECRET), false, `${name} holds no plaintext client secret`);
  }
  assert.ok(fake.log.every(entry => entry.method === 'GET' || ['/token', '/revoke'].includes(entry.path)), 'only reads and token calls reached Google');

  assert.equal((await l.revoke('personal')).remote, 'revoked');
  assert.deepEqual(l.list().map(c => c.state), ['revoked']);
}));

test('the listener answers only the pending state; a wrong account is refused and nothing is stored', async () => rig(async ({ fake, local, consent }) => {
  fake.clientId = REAL_ID;
  const l = await local();
  l.setClient(JSON.stringify({ installed: { client_id: REAL_ID, client_secret: CLIENT_SECRET } }));
  let stray: number | undefined;
  const attempt = l.connect({ name: 'personal', email: ACCOUNTS.personal.email, onUrl: url => {
    const redirect = new URL(url).searchParams.get('redirect_uri')!;
    void fetch(`${redirect}?state=forged&code=x`).then(r => { stray = r.status; }).then(() => consent(url, 'dentai'));
  } });
  await assert.rejects(attempt, /google_account_mismatch/);
  assert.equal(stray, 404);
  assert.deepEqual(l.list(), []);
}));

test('consent that never returns times out and closes the listener', async () => rig(async ({ fake, local }) => {
  fake.clientId = REAL_ID;
  const l = await local();
  l.setClient(JSON.stringify({ installed: { client_id: REAL_ID, client_secret: CLIENT_SECRET } }));
  let redirect = '';
  await assert.rejects(l.connect({ name: 'personal', email: ACCOUNTS.personal.email, timeoutMs: 200, onUrl: url => { redirect = new URL(url).searchParams.get('redirect_uri')!; } }), /google_consent_timeout/);
  await assert.rejects(fetch(redirect), 'the port no longer listens');
}));
