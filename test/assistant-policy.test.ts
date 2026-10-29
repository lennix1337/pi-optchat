import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { createAssistantPolicy } from '../src/assistant-policy.ts';
import type { EffectRequest } from '../assistant/src/policy/gateway.ts';
import { withTempDir } from './support.ts';

const request = (destination: string): EffectRequest => ({ version: 1, operationId: 'operation', profileId: 'profile', sessionId: 'session', taskId: 'task', runId: 'run', adapter: 'mail-fixture', action: 'send', account: 'account-a', destination, policyVersion: 'v1', expiresAt: Date.now() + 60000, payload: Buffer.from('reviewed fixture') });

test('host adapter delivers approved metadata and exact bytes to a real disposable loopback sink', () => withTempDir('policy-host-', async dir => {
  const received: { path: string; account: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ path: req.url!, account: String(req.headers['x-fixture-account']), body: Buffer.concat(chunks).toString('utf8') });
    res.end('accepted');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const destination = `http://127.0.0.1:${address.port}/approved`;
  const authority = {}; let version = 'v1', mutate = false;
  const original = request(destination);
  const policy = createAssistantPolicy({ databasePath: join(dir, 'policy.sqlite'), profileId: 'profile', operatorAuthority: authority,
    contractDir: () => undefined, policyVersion: () => version,
    knownSecrets: () => { if (mutate) original.destination = destination.replace('/approved', '/wrong'); return ['SECRET-CANARY']; },
    adapters: { 'mail-fixture': {
      accepts: m => m.action === 'send' && m.account === 'account-a' && m.destination === destination,
      classify: () => 'review',
      invoke: async (bytes, m) => {
        const response = await fetch(m.destination, { method: 'POST', body: Buffer.from(bytes), headers: { 'x-fixture-account': m.account }, redirect: 'error', signal: AbortSignal.timeout(2000) });
        assert.equal(response.status, 200); return response.text();
      },
    } },
  });
  try {
    const review = policy.prepare(original); assert.equal(review.decision, 'review');
    assert.throws(() => policy.decide(review.reviewId!, 'approve', { source: 'operator' }), /unauthorized/);
    policy.decide(review.reviewId!, 'approve', authority);
    await assert.rejects(policy.dispatch({ ...original, payload: Buffer.from('altered') }), /approval_required/);
    await assert.rejects(policy.dispatch({ ...original, payload: Buffer.from('SECRET-CANARY') }), /denied/);
    await assert.rejects(policy.dispatch({ ...original, adapter: '__proto__' }), /denied/);
    await assert.rejects(policy.dispatch({ ...original, account: 'account-b' }), /denied/);
    version = 'v2'; await assert.rejects(policy.dispatch(original), /denied/); version = 'v1';
    assert.deepEqual(received, []);
    mutate = true;
    assert.equal(await policy.dispatch(original), 'accepted');
    assert.deepEqual(received, [{ path: '/approved', account: 'account-a', body: 'reviewed fixture' }]);
    assert.equal(policy.status('operation'), 'response_recorded');
    mutate = false; original.destination = destination;
    await assert.rejects(policy.dispatch(original), /already_dispatched/);
    assert.equal(received.length, 1);
  } finally { policy.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test('host uses the same autonomy contract for mapped effects and does not gate allowed reads', () => withTempDir('policy-native-', async dir => {
  writeFileSync(join(dir, 'autonomy.json'), JSON.stringify({ version: 1, default: 'ask', rules: [
    { action: 'push', scope: ['fixture/repo'], level: 'free' }, { action: 'publish', scope: ['fixture/repo'], level: 'report' },
  ] }));
  const seen: string[] = [];
  const policy = createAssistantPolicy({ databasePath: join(dir, 'policy.sqlite'), profileId: 'profile', operatorAuthority: {},
    contractDir: () => dir, policyVersion: () => 'v1', knownSecrets: () => [], adapters: {
      'mapped-fixture': { accepts: m => m.account === 'account-a' && m.destination === 'fixture/repo' && ['push', 'publish'].includes(m.action),
        classify: m => [{ action: m.action as 'push' | 'publish', targets: ['fixture/repo'] }], invoke: (_bytes, m) => { seen.push(m.action); } },
      'read-fixture': { accepts: m => m.action === 'read' && m.account === 'account-a' && m.destination === 'fixture/repo',
        classify: () => 'read', invoke: (_bytes, m) => { seen.push(m.action); } },
    },
  });
  try {
    for (const action of ['push', 'publish', 'read']) {
      const r = { ...request('fixture/repo'), operationId: action, adapter: action === 'read' ? 'read-fixture' : 'mapped-fixture', action };
      assert.deepEqual(policy.prepare(r), { decision: 'allow' }); await policy.dispatch(r);
    }
    assert.deepEqual(seen, ['push', 'publish', 'read']);
    const audit = readFileSync(join(dir, 'autonomy-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(audit.length, 1); assert.equal(audit[0].action, 'publish');
    assert.equal(JSON.stringify(audit).includes('reviewed fixture'), false);
  } finally { policy.close(); }
}));
