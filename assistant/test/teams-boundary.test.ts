import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { TeamsChannel, verifyTeams, type Jwk } from '../src/channels/teams.ts';
import { channelFixture, PROFILE } from './channel-support.ts';

const NOW = 1_793_000_000_000;
const APP = '00000000-0000-4000-8000-0000000000a1';
const TENANT = '00000000-0000-4000-8000-0000000000b2';
const SERVICE = 'https://smba.trafficmanager.net/br/';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys: Jwk[] = [{ ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k1', endorsements: ['msteams'] }];
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key: KeyObject = privateKey) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...header });
  const body = b64({ iss: 'https://api.botframework.com', aud: APP, serviceurl: SERVICE, nbf: NOW / 1000 - 60, exp: NOW / 1000 + 600, ...claims });
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}
const activity = (over: Record<string, unknown> = {}) => ({
  type: 'message', id: `act-${Math.random().toString(36).slice(2)}`, serviceUrl: SERVICE, channelId: 'msteams', text: 'Preparar pauta da reuni\u00e3o',
  from: { id: '29:owner', aadObjectId: '00000000-0000-4000-8000-0000000000c3', role: 'user' },
  conversation: { id: 'a:conv-1', tenantId: TENANT }, channelData: { tenant: { id: TENANT } }, ...over,
});
function teams(f: ReturnType<typeof channelFixture>) {
  return new TeamsChannel({ store: f.store, ledger: f.ledger, profileId: PROFILE, appId: APP, tenantId: TENANT, keys: () => keys, now: () => NOW, reviewLink: id => `http://127.0.0.1:1/#tarefa=${id}` });
}

test('bot framework tokens are verified for signature, key, issuer, audience, lifetime and service URL', () => {
  const ok = (token: string, serviceUrl = SERVICE) => verifyTeams(`Bearer ${token}`, { appId: APP, keys, now: NOW, serviceUrl });
  assert.equal(ok(jwt()), true);
  assert.equal(ok(jwt({}, {}, other.privateKey)), false, 'wrong signer');
  assert.equal(ok(jwt({}, { kid: 'unknown' })), false);
  assert.equal(ok(jwt({}, { alg: 'none' })), false);
  assert.equal(ok(jwt({ iss: 'https://evil.test' })), false);
  assert.equal(ok(jwt({ aud: 'other-app' })), false);
  assert.equal(ok(jwt({ exp: NOW / 1000 - 600 })), false, 'expired beyond skew');
  assert.equal(ok(jwt({ nbf: NOW / 1000 + 600 })), false);
  assert.equal(ok(jwt(), 'https://evil.test/'), false, 'activity service URL must match the token');
  assert.equal(verifyTeams('', { appId: APP, keys, now: NOW, serviceUrl: SERVICE }), false);
  assert.equal(verifyTeams(`Bearer ${jwt()}x`, { appId: APP, keys, now: NOW, serviceUrl: SERVICE }), false);
});

test('an authorized tenant user creates one suggested task; other tenants, bots, unknown users and replays do not', () => {
  const f = channelFixture();
  try {
    f.ledger.authorize('teams', TENANT, '00000000-0000-4000-8000-0000000000c3', 'operador', f.authority);
    const receive = (body: Record<string, unknown>, token = jwt()) => teams(f).receive(`Bearer ${token}`, JSON.stringify(body));
    const first = activity({ id: 'act-once' });
    const created = receive(first);
    assert.equal(created.outcome, 'task_created');
    assert.equal(f.store.get(created.taskId!)!.status, 'suggested');
    assert.equal(f.store.events(0, 10)[0].event.source.actorId, `teams:${TENANT}:00000000-0000-4000-8000-0000000000c3`);
    assert.equal(receive(first).outcome, 'duplicate');
    assert.equal(receive(activity({ channelData: { tenant: { id: 'other-tenant' } } })).outcome, 'foreign_workspace');
    assert.equal(receive(activity({ from: { id: '28:bot', aadObjectId: '00000000-0000-4000-8000-0000000000c3', role: 'bot' } })).outcome, 'ignored_not_human', 'a bot echoing the owner id is still a bot');
    assert.equal(receive(activity({ from: { id: '29:x', aadObjectId: 'stranger', role: 'user' } })).outcome, 'unauthorized_sender');
    assert.equal(receive(activity(), jwt({ aud: 'x' })).outcome, 'unauthenticated');
    assert.equal(f.store.list().tasks.length, 1);
  } finally { f.close(); }
});

test('a reply in the recorded conversation answers the current input only', () => {
  const f = channelFixture();
  try {
    f.ledger.authorize('teams', TENANT, '00000000-0000-4000-8000-0000000000c3', 'operador', f.authority);
    const task = f.needsInput();
    f.ledger.recordThread({ platform: 'teams', account: TENANT, conversation: 'a:conv-1', thread: 'msg-ask-1', taskId: task.taskId, revision: task.revision, inputRevision: task.inputRevision });
    const receive = (body: Record<string, unknown>) => teams(f).receive(`Bearer ${jwt()}`, JSON.stringify(body));
    assert.equal(receive(activity({ replyToId: 'msg-ask-1', text: 'Pode ser sexta' })).outcome, 'responded');
    assert.equal(receive(activity({ replyToId: 'msg-ask-1', text: 'sexta n\u00e3o' })).outcome, 'stale');
  } finally { f.close(); }
});
