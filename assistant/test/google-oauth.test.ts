import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { GOOGLE_READ_SCOPES, GoogleConnections } from '../src/connectors/google.ts';
import { contains, diskBytes } from './vault-support.ts';
import { ACCOUNTS, CALENDAR_SCOPE, CLIENT_ID, CLIENT_SECRET, MAIL_SCOPE, TOKEN_CANARY, hour, withGoogle } from './google-support.ts';

const params = (url: string) => new URL(url).searchParams;

test('authorization asks only for read scopes with state, S256 PKCE, nonce and the exact loopback redirect', () => withGoogle(async ({ google, authority, redirectUri, fake }) => {
  assert.deepEqual([...GOOGLE_READ_SCOPES].sort(), ['email', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/gmail.readonly', 'openid']);
  const first = google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.personal.email }, authority);
  const second = google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.personal.email }, authority);
  const p = params(first.url);
  assert.equal(`${new URL(first.url).origin}${new URL(first.url).pathname}`, fake.endpoints.authorization);
  assert.equal(p.get('redirect_uri'), redirectUri);
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('response_type'), 'code');
  assert.deepEqual(p.get('scope')!.split(' ').sort(), [...GOOGLE_READ_SCOPES].sort());
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.match(p.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.get('login_hint'), ACCOUNTS.personal.email);
  assert.equal(first.state, p.get('state'));
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.state, second.state, 'every attempt has its own state');
  assert.notEqual(p.get('code_challenge'), params(second.url).get('code_challenge'));
  assert.notEqual(p.get('nonce'), params(second.url).get('nonce'));
  assert.ok(!p.has('client_secret'), 'the client secret never goes to the browser');
  assert.throws(() => google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.personal.email }, {}), /unauthorized/);
  assert.throws(() => google.begin({ connectionId: 'personal', expectedEmail: 'not-an-email' }, authority), /invalid_connection/);
  assert.throws(() => google.begin({ connectionId: '', expectedEmail: ACCOUNTS.personal.email }, authority), /invalid_connection/);
}));

test('the redirect must be an exact loopback address', () => withGoogle(async ({ open }) => {
  for (const redirectUri of ['https://example.test/callback', 'http://localhost:47613/cb', 'http://127.0.0.1/cb', 'http://127.0.0.1:47613/cb?x=1', 'http://user@127.0.0.1:47613/cb', 'http://10.0.0.5:47613/cb']) {
    assert.throws(() => new GoogleConnections({ databasePath: ':memory:', profileId: 'p', operatorAuthority: {}, vault: {} as never, gateway: {} as never, clientId: CLIENT_ID, redirectUri }), /invalid_options/, redirectUri);
  }
  assert.ok(open());
}));

test('a completed authorization stores tokens only as vault references bound to the verified account', () => withGoogle(async ({ google, authority, fake, vault, dir, databasePath }) => {
  const { url } = google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.personal.email }, authority);
  const callback = fake.consent(url, 'personal');
  const connection = await google.complete(callback, authority);
  assert.deepEqual(connection, { connectionId: 'personal', subject: ACCOUNTS.personal.sub, email: ACCOUNTS.personal.email, scopes: [...GOOGLE_READ_SCOPES].sort(), state: 'active' });
  const exchange = fake.requests('/token')[0].params;
  assert.equal(exchange.grant_type, 'authorization_code');
  assert.equal(exchange.redirect_uri, params(url).get('redirect_uri'));
  assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'), params(url).get('code_challenge'), 'the verifier proves the S256 challenge');
  assert.deepEqual(google.list(), [connection]);
  const refs = vault.list('p').filter(s => s.action !== 'google.client');
  assert.deepEqual(refs.map(s => s.action).sort(), ['google.access', 'google.refresh']);
  const db = new DatabaseSync(databasePath);
  const row = JSON.stringify(db.prepare('SELECT * FROM google_connections').all());
  db.close();
  for (const ref of refs) assert.ok(row.includes(ref.ref), 'the connection holds opaque references');
  assert.ok(!contains(diskBytes(dir), TOKEN_CANARY), 'no token on disk in any common encoding');
  assert.ok(!contains(diskBytes(dir), CLIENT_SECRET));
  assert.ok(!JSON.stringify(connection).includes(TOKEN_CANARY));

  await assert.rejects(google.complete(callback, authority), /google_state_invalid/, 'a callback is single-use');
  assert.equal(fake.requests('/token').length, 1);
}));

test('a forged, replayed or expired state is refused before any token request', () => withGoogle(async ({ google, authority, fake, clock, vault }) => {
  const { url } = google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.personal.email }, authority);
  const genuine = new URL(fake.consent(url, 'personal'));
  const forged = new URL(genuine.href);
  forged.searchParams.set('state', 'A'.repeat(43));
  await assert.rejects(google.complete(forged.href, authority), /google_state_invalid/);
  const missing = new URL(genuine.href);
  missing.searchParams.delete('state');
  await assert.rejects(google.complete(missing.href, authority), /google_state_invalid/);
  assert.equal(fake.requests('/token').length, 0, 'a callback that is not ours never reaches the token endpoint');

  const late = google.begin({ connectionId: 'dentai', expectedEmail: ACCOUNTS.dentai.email }, authority);
  const lateCallback = fake.consent(late.url, 'dentai');
  clock.now += 11 * 60_000;
  await assert.rejects(google.complete(lateCallback, authority), /google_state_expired/);
  await assert.rejects(google.complete(genuine.href, authority), /google_state_expired/);
  assert.equal(fake.requests('/token').length, 0);
  assert.deepEqual(google.list(), []);
  assert.deepEqual(vault.list('p').filter(s => s.action !== 'google.client'), []);
  await assert.rejects(google.complete(genuine.href, {}), /unauthorized/);
}));

test('a callback on another path, port or host is refused, and a consent error is reported without a token request', () => withGoogle(async ({ google, authority, fake }) => {
  for (const change of [(u: URL) => { u.port = '47614'; }, (u: URL) => { u.pathname = '/other'; }, (u: URL) => { u.hostname = 'localhost'; }]) {
    const { url } = google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.personal.email }, authority);
    const callback = new URL(fake.consent(url, 'personal'));
    change(callback);
    await assert.rejects(google.complete(callback.href, authority), /google_redirect_mismatch/);
  }
  const { url, state } = google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.personal.email }, authority);
  const denied = new URL(params(url).get('redirect_uri')!);
  denied.searchParams.set('state', state);
  denied.searchParams.set('error', 'access_denied');
  await assert.rejects(google.complete(denied.href, authority), /google_consent_denied/);
  assert.equal(fake.requests('/token').length, 0);
}));

test('the verified identity must be the expected account: a different Google account is refused and none of its tokens kept', () => withGoogle(async ({ google, authority, fake, vault, dir }) => {
  const { url } = google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.personal.email }, authority);
  await assert.rejects(google.complete(fake.consent(url, 'dentai'), authority), /google_account_mismatch/, 'the user picked the DentAI account at the consent screen');
  assert.deepEqual(google.list(), []);
  assert.deepEqual(vault.list('p').filter(s => s.action !== 'google.client'), [], 'no token of the wrong account is kept');
  assert.ok(!contains(diskBytes(dir), TOKEN_CANARY));
  // Revoking at Google would revoke that account's whole grant to this client, including a connection that legitimately uses it.
  assert.equal(fake.requests('/revoke').length, 0);
}));

test('an id_token for another client, a wrong nonce, an unverified email or an expired token is refused', () => withGoogle(async ({ google, authority, fake, clock }) => {
  for (const [override, code] of [[{ aud: 'other-client' }, /google_identity_invalid/], [{ nonce: 'replayed' }, /google_identity_invalid/], [{ email_verified: false }, /google_identity_invalid/], [{ iss: 'https://evil.example' }, /google_identity_invalid/], [{ exp: Math.floor(clock.now / 1000) - 1 }, /google_identity_invalid/], [{ sub: undefined }, /google_identity_invalid/]] as const) {
    fake.idTokenOverride = override;
    const { url } = google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.personal.email }, authority);
    await assert.rejects(google.complete(fake.consent(url, 'personal'), authority), code, JSON.stringify(override));
  }
  assert.deepEqual(google.list(), []);
}));

test('a broader grant than read-only is refused; a partial grant records only what was granted', () => withGoogle(async ({ google, authority, fake }) => {
  fake.grantedScopes = ['openid', 'email', MAIL_SCOPE, 'https://www.googleapis.com/auth/gmail.send'];
  let { url } = google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.personal.email }, authority);
  await assert.rejects(google.complete(fake.consent(url, 'personal'), authority), /google_scope_mismatch/);
  assert.deepEqual(google.list(), []);
  fake.grantedScopes = ['openid', 'email', MAIL_SCOPE];
  ({ url } = google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.personal.email }, authority));
  const connection = await google.complete(fake.consent(url, 'personal'), authority);
  assert.deepEqual(connection.scopes, ['email', MAIL_SCOPE, 'openid'].sort());
  assert.ok(!connection.scopes.includes(CALENDAR_SCOPE));
}));

test('personal and DentAI are separate explicit connections: no default, no shared account, each reads its own data', () => withGoogle(async ({ google, connect, authority, fake }) => {
  fake.mail.personal.push({ id: 'p1', from: 'friend@example.test', subject: 'Dinner', body: 'see you', receivedAt: '2026-10-28T10:00:00.000Z' });
  fake.mail.dentai.push({ id: 'd1', from: 'client@clinic.example.test', subject: 'Contract', body: 'signed', receivedAt: '2026-10-28T09:00:00.000Z' });
  await connect('personal', 'personal');
  await connect('dentai', 'dentai');
  assert.deepEqual(google.list().map(c => [c.connectionId, c.email]), [['dentai', ACCOUNTS.dentai.email], ['personal', ACCOUNTS.personal.email]]);
  assert.deepEqual((await google.listMessages('personal')).items.map(m => [m.ref.connectionId, m.ref.account, m.subject]), [['personal', ACCOUNTS.personal.email, 'Dinner']]);
  assert.deepEqual((await google.listMessages('dentai')).items.map(m => [m.ref.connectionId, m.ref.account, m.subject]), [['dentai', ACCOUNTS.dentai.email, 'Contract']]);
  assert.deepEqual(fake.requests('/gmail').map(r => r.account), ['personal', 'personal', 'dentai', 'dentai']);
  await assert.rejects(google.listMessages('default'), /google_connection_unknown/);
  await assert.rejects(google.listMessages(undefined as never), /google_connection_unknown/);

  const { url } = google.begin({ connectionId: 'work-copy', expectedEmail: ACCOUNTS.dentai.email }, authority);
  await assert.rejects(google.complete(fake.consent(url, 'dentai'), authority), /google_account_already_connected/, 'one Google account is one connection');
  await google.revoke('dentai', authority);
  const again = google.begin({ connectionId: 'personal', expectedEmail: ACCOUNTS.dentai.email }, authority);
  await assert.rejects(google.complete(fake.consent(again.url, 'dentai'), authority), /google_account_mismatch/, 'a connection keeps the account it was bound to');
}));

test('an expired access token is refreshed through the vault and the read continues', () => withGoogle(async ({ google, connect, fake, clock, dir }) => {
  fake.mail.personal.push({ id: 'p1', from: 'a@example.test', subject: 'Hi', body: 'x', receivedAt: '2026-10-28T11:00:00.000Z' });
  await connect('personal', 'personal');
  clock.now += 2 * hour;
  assert.equal((await google.listMessages('personal')).items.length, 1);
  const refreshes = fake.requests('/token').filter(r => r.params.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].params.client_secret, CLIENT_SECRET);
  assert.ok(!contains(diskBytes(dir), TOKEN_CANARY));
}));

test('revocation removes access locally at once, revokes at Google, and erases the stored tokens', () => withGoogle(async ({ google, connect, authority, fake, vault, open }) => {
  await connect('personal', 'personal');
  await connect('dentai', 'dentai');
  await assert.rejects(google.revoke('personal', {}), /unauthorized/);
  assert.deepEqual(await google.revoke('personal', authority), { connectionId: 'personal', remote: 'revoked' });
  assert.equal(fake.requests('/revoke').length, 1);
  assert.match(fake.requests('/revoke')[0].params.token, /-refresh-/);
  const before = fake.log.length;
  await assert.rejects(google.listMessages('personal'), /google_connection_revoked/);
  await assert.rejects(open().listEvents('personal', { from: '2026-10-28T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z', timeZone: 'UTC' }), /google_connection_revoked/, 'also from a fresh instance');
  assert.equal(fake.log.length, before, 'a revoked connection makes no request at all');
  assert.ok(vault.list('p').filter(s => s.action !== 'google.client' && !s.revoked).length === 2, 'only the other connection keeps live references');
  assert.equal(google.list().find(c => c.connectionId === 'personal')!.state, 'revoked');
  assert.equal((await google.listMessages('dentai')).items.length, 0, 'the other connection is unaffected');
}));

test('a failed remote revocation still removes local access and is reported as not confirmed', () => withGoogle(async ({ google, connect, authority, fake, vault }) => {
  await connect('personal', 'personal');
  fake.failRevoke = true;
  assert.deepEqual(await google.revoke('personal', authority), { connectionId: 'personal', remote: 'not_confirmed' });
  await assert.rejects(google.listMessages('personal'), /google_connection_revoked/);
  assert.ok(vault.list('p').filter(s => s.action !== 'google.client').every(s => s.revoked));
}));
