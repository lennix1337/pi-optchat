import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectEgress } from '../src/policy/egress.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

test('known secrets deny without exposing matches, including overlapping secrets', () => {
  const canary = 'canary-SECRET-unique';
  const result = inspectEgress(bytes(`prefix ${canary} suffix`), ['SECRET', canary]);
  assert.equal(result.decision, 'deny');
  assert.ok(result.reasons.includes('known_secret'));
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(inspectEgress(bytes('ordinary'), ['']).decision, 'review');
});

test('likely payment, authentication and identifiers require review', () => {
  for (const [text, reason] of [
    ['Card: 4111 1111 1111 1111', 'payment_data'],
    ['api_key = abcdef12345', 'authentication_data'],
    ['SSN: 123-45-6789', 'sensitive_identifier'],
  ] as const) {
    const result = inspectEgress(bytes(text), []);
    assert.equal(result.decision, 'review');
    assert.ok(result.reasons.includes(reason));
    assert.equal(JSON.stringify(result).includes(text), false);
  }
});

test('generic text and benign numbers are allowed', () => {
  for (const text of ['Hello world', 'Order 12345 shipped in 2026', '4111 1111 1111 1112']) {
    assert.deepEqual(inspectEgress(bytes(text), []), { decision: 'allow', reasons: [] });
  }
});

test('malformed UTF-8 and oversized input require review, but secrets still deny', () => {
  assert.ok(inspectEgress(new Uint8Array([0xff]), []).reasons.includes('invalid_utf8'));
  assert.equal(inspectEgress(new Uint8Array([0xff]), []).decision, 'review');
  const large = bytes('x'.repeat(1024 * 1024 + 1));
  assert.ok(inspectEgress(large, []).reasons.includes('oversize'));
  assert.equal(inspectEgress(large, []).decision, 'review');
  assert.equal(inspectEgress(large, ['xxx']).decision, 'deny');
  assert.equal(inspectEgress(new Uint8Array([0xff, 0x61]), ['a']).decision, 'deny');
  assert.equal(inspectEgress(bytes('x'.repeat(1024 * 1024)), []).decision, 'allow');
});

test('inspection does not mutate input or secrets', () => {
  const input = bytes('api_key=example123');
  const original = input.slice();
  const secrets = Object.freeze(['other']);
  inspectEgress(input, secrets);
  assert.deepEqual(input, original);
  assert.deepEqual(secrets, ['other']);
});
