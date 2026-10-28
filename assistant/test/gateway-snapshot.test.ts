import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { snapshot, type EffectRequest } from '../src/policy/grants.ts';

const now = 1000;
function request(): EffectRequest {
  return { version: 1, operationId: 'op', profileId: 'p', sessionId: 'session', taskId: 'task', runId: 'run', adapter: 'adapter', action: 'action', account: 'account', destination: 'destination', policyVersion: 'policy', expiresAt: 2000, payload: new Uint8Array([1, 2, 3]) };
}

test('snapshot rejects request accessors without executing them', () => {
  for (const field of ['version', 'profileId', 'expiresAt', 'payload', 'destination', 'operationId'] as const) {
    const input = request();
    let reads = 0;
    Object.defineProperty(input, field, { get() { reads++; throw new Error('getter-canary'); } });
    assert.throws(() => snapshot(input, 'p', now), { message: 'invalid_request' }, field);
    assert.equal(reads, 0, field);
  }
});

test('snapshot owns payload and metadata and keeps exact binding separate from operation', () => {
  const input = request();
  const first = snapshot(input, 'p', now);
  const same = snapshot(request(), 'p', now);
  assert.equal(first.binding, same.binding);
  assert.equal(first.operation, same.operation);
  const otherOperation = snapshot({ ...request(), operationId: 'other' }, 'p', now);
  assert.equal(first.binding, otherOperation.binding);
  assert.notEqual(first.operation, otherOperation.operation);
  const otherDestination = snapshot({ ...request(), destination: 'other' }, 'p', now);
  assert.notEqual(first.binding, otherDestination.binding);
  assert.equal(first.operation, otherDestination.operation);
  input.payload[0] = 9;
  input.profileId = 'foreign';
  assert.deepEqual([...first.payload], [1, 2, 3]);
  assert.equal(first.metadata.profileId, 'p');
  assert.equal(first.binding, same.binding);
});

test('snapshot copies shared payload bytes and rejects nonplain or throwing proxy requests', () => {
  const bytes = new Uint8Array(new SharedArrayBuffer(3));
  bytes.set([1, 2, 3]);
  const result = snapshot({ ...request(), payload: bytes }, 'p', now);
  bytes.fill(9);
  assert.deepEqual([...result.payload], [1, 2, 3]);
  assert.throws(() => snapshot(Object.assign(Object.create({}), request()), 'p', now), { message: 'invalid_request' });
  const proxy = new Proxy(request(), { getPrototypeOf() { throw new Error('proxy-canary'); } });
  assert.throws(() => snapshot(proxy, 'p', now), { message: 'invalid_request' });
});

test('snapshot validates captured plain data', () => {
  for (const input of [
    { ...request(), profileId: 'foreign' }, { ...request(), expiresAt: now },
    { ...request(), expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { ...request(), destination: ' bad' },
    { ...request(), destination: '\ud800' }, { ...request(), destination: 'a\u001b' },
    { ...request(), destination: 'a'.repeat(1025) }, { ...request(), payload: new Uint8Array(1024 * 1024 + 1) },
  ]) assert.throws(() => snapshot(input, 'p', now), { message: 'invalid_request' });
});
