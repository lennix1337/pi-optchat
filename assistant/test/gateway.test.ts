import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, type EffectRequest } from '../src/policy/gateway.ts';

test('exact review, authority, mutation, denial and expiry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-')); const authority = {}; let now = 100; let deny = false;
  const options = { databasePath: join(dir, 'policy.db'), profileId: 'profile', operatorAuthority: authority, now: () => now, policy: () => 'review' as const, inspect: () => ({ decision: deny ? 'deny' as const : 'allow' as const, reasons: [] }) };
  const gateway = createGateway(options);
  const request: EffectRequest = { version: 1, operationId: 'op', profileId: 'profile', sessionId: 'session', taskId: 'task', runId: 'run', adapter: 'mail', action: 'send', account: 'account', destination: 'destination', policyVersion: 'v1', expiresAt: 200, payload: Buffer.from('message') };
  try {
    const id = gateway.prepare(request).reviewId!;
    assert.throws(() => gateway.decide(id, 'approve', { source: 'operator' }), /unauthorized/);
    gateway.decide(id, 'approve', authority);
    for (const change of [{ payload: Buffer.from('different') }, { destination: 'other' }, { account: 'other' }, { sessionId: 'other' }, { taskId: 'other' }, { runId: 'other' }, { policyVersion: 'v2' }, { expiresAt: 199 }]) await assert.rejects(gateway.dispatch({ ...request, ...change }, () => assert.fail()), /approval_required/);
    await assert.rejects(gateway.dispatch({ ...request, profileId: 'other' }, () => assert.fail()), /invalid_request/);
    deny = true; await assert.rejects(gateway.dispatch(request, () => assert.fail()), /denied/); deny = false;
    const pending = gateway.dispatch(request, async bytes => { request.payload[0] = 88; assert.equal(Buffer.from(bytes).toString(), 'message'); }); await pending;
    assert.equal(gateway.status('op'), 'response_recorded');
    now = 201; assert.throws(() => gateway.prepare({ ...request, operationId: 'new' }), /invalid_request/);
  } finally { gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('allowed local effect requires no review and failures remain uncertain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-')); const authority = {};
  const gateway = createGateway({ databasePath: join(dir, 'db'), profileId: 'p', operatorAuthority: authority, policy: () => 'allow', inspect: () => ({ decision: 'allow', reasons: [] }) });
  const r: EffectRequest = { version: 1, operationId: 'o', profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'local', action: 'read', account: 'a', destination: 'd', policyVersion: 'v', expiresAt: Date.now() + 60000, payload: Buffer.from('safe') };
  try { assert.deepEqual(gateway.prepare(r), { decision: 'allow' }); let accepted = 0; await assert.rejects(gateway.dispatch(r, () => { accepted++; throw new Error('secret-recipient-payload-canary'); }), error => { assert.equal(String(error), 'Error: effect_uncertain'); assert.equal((error as Error).cause, undefined); return true; }); assert.equal(gateway.status('o'), 'uncertain'); await assert.rejects(gateway.dispatch(r, () => { accepted++; }), /already_dispatched/); assert.equal(accepted, 1); } finally { gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('final admission rechecks callbacks against owned snapshot and fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-final-')); let calls = 0; let mode: 'deny' | 'throw' = 'deny';
  const r: EffectRequest = { version: 1, operationId: 'o', profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'a', action: 'x', account: 'a', destination: 'd', policyVersion: 'v', expiresAt: Date.now() + 60000, payload: Buffer.from('original') };
  const gateway = createGateway({ databasePath: join(dir, 'db'), profileId: 'p', operatorAuthority: {}, policy: metadata => { calls++; if (calls % 2 === 1) { r.destination = 'changed'; r.payload[0] = 88; return 'allow'; } assert.equal(metadata.destination, 'd'); if (mode === 'throw') throw new Error('sensitive'); return 'deny'; }, inspect: bytes => { assert.equal(Buffer.from(bytes).toString(), 'original'); return { decision: 'allow', reasons: [] }; } });
  try { await assert.rejects(gateway.dispatch(r, () => assert.fail()), /denied/); assert.equal(gateway.status('o'), 'absent'); r.destination = 'd'; r.payload = Buffer.from('original'); mode = 'throw'; await assert.rejects(gateway.dispatch(r, () => assert.fail()), /policy_error/); assert.equal(gateway.status('o'), 'absent'); } finally { gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('sink receives approved owned metadata and bytes despite caller mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-metadata-')); const authority = {}; let mutate = false;
  const r: EffectRequest = { version: 1, operationId: 'o', profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'mail', action: 'send', account: 'account', destination: 'destination', policyVersion: 'v', expiresAt: Date.now() + 60000, payload: Buffer.from('original') };
  const gateway = createGateway({ databasePath: join(dir, 'db'), profileId: 'p', operatorAuthority: authority, policy: () => { if (mutate) { r.destination = 'changed'; r.account = 'changed'; r.adapter = 'changed'; r.action = 'changed'; r.payload[0] = 88; } return 'review'; }, inspect: () => ({ decision: 'allow', reasons: [] }) });
  try {
    gateway.decide(gateway.prepare(r).reviewId!, 'approve', authority); mutate = true;
    let receipt: unknown;
    await gateway.dispatch(r, (bytes, metadata) => { receipt = { bytes: Buffer.from(bytes).toString(), metadata, frozen: Object.isFrozen(metadata) }; });
    assert.deepEqual(receipt, { bytes: 'original', metadata: { version: 1, operationId: 'o', profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'mail', action: 'send', account: 'account', destination: 'destination', policyVersion: 'v', expiresAt: r.expiresAt }, frozen: true });
  } finally { gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('response persistence failure is safe and remains uncertain after reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-response-')); const authority = {};
  const options = { databasePath: join(dir, 'db'), profileId: 'p', operatorAuthority: authority, policy: () => 'allow' as const, inspect: () => ({ decision: 'allow' as const, reasons: [] }) };
  const r: EffectRequest = { version: 1, operationId: 'o', profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'a', action: 'x', account: 'a', destination: 'd', policyVersion: 'v', expiresAt: Date.now() + 60000, payload: Buffer.from('x') };
  let gateway = createGateway(options); let accepted = 0; let closed = false;
  try {
    await assert.rejects(gateway.dispatch(r, () => { accepted++; gateway.close(); closed = true; }), error => { assert.equal(String(error), 'Error: effect_uncertain'); assert.equal((error as Error).cause, undefined); return true; });
    gateway = createGateway(options); closed = false; assert.equal(gateway.status('o'), 'uncertain');
    await assert.rejects(gateway.dispatch(r, () => { accepted++; }), /operation_already_dispatched/); assert.equal(accepted, 1);
  } finally { if (!closed) gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('denial, nonmutating status and persistence failure never invoke sink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-failure-')); const authority = {};
  const gateway = createGateway({ databasePath: join(dir, 'db'), profileId: 'p', operatorAuthority: authority, policy: () => 'review', inspect: () => ({ decision: 'allow', reasons: [] }) });
  const r: EffectRequest = { version: 1, operationId: 'o', profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'a', action: 'x', account: 'a', destination: 'd', policyVersion: 'v', expiresAt: Date.now() + 60000, payload: Buffer.from('x') };
  try { const id = gateway.prepare(r).reviewId!; gateway.decide(id, 'deny', authority); assert.equal(gateway.status('o'), 'absent'); await assert.rejects(gateway.dispatch(r, () => assert.fail()), /approval_required/); assert.throws(() => gateway.decide(id, 'approve', authority), /invalid_review/); const approved = gateway.prepare(r).reviewId!; gateway.decide(approved, 'approve', authority); assert.equal(gateway.status('o'), 'absent'); gateway.close(); await assert.rejects(gateway.dispatch(r, () => assert.fail())); } finally { rmSync(dir, { recursive: true, force: true }); }
});
