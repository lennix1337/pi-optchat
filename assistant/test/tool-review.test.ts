import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/policy/gateway.ts';

test('exact pending review and mandatory grant survive policy changing to allow', async () => {
  const authority = {}; let policy: 'review' | 'allow' | 'deny' = 'review';
  const gateway = createGateway({ databasePath: ':memory:', profileId: 'p', operatorAuthority: authority, policy: () => policy, inspect: () => ({ decision: 'allow', reasons: [] }) });
  const request = { version: 1 as const, operationId: 'o', profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'computer', action: 'browser_text', account: 'a', destination: 'd', policyVersion: 'v', expiresAt: Date.now() + 60000, payload: Buffer.from('hello') };
  try {
    const review = gateway.prepare(request); assert.equal(review.decision, 'review'); if (review.decision !== 'review') throw new Error('review');
    const view = gateway.pendingReview(review.reviewId, request)!;
    assert.equal(Buffer.from(view.payload).toString(), 'hello'); view.payload.fill(0);
    const again = gateway.pendingReview(review.reviewId, request);
    assert.ok(again, 'pending review remains readable');
    assert.equal(Buffer.from(again.payload).toString(), 'hello');
    assert.equal(gateway.pendingReview(review.reviewId, { ...request, payload: Buffer.from('other') }), undefined);
    policy = 'allow'; let calls = 0;
    await assert.rejects(gateway.dispatchReviewed(request, review.reviewId, () => { calls++; }), /approval_required/); assert.equal(calls, 0);
    gateway.decide(review.reviewId, 'approve', authority); assert.equal(gateway.pendingReview(review.reviewId, request), undefined);
    const other = createGateway({ databasePath: ':memory:', profileId: 'p', operatorAuthority: authority, policy: () => 'allow', inspect: () => ({ decision: 'allow', reasons: [] }) });
    try { await assert.rejects(other.dispatchReviewed(request, review.reviewId, () => { calls++; }), /approval_required/); assert.equal(calls, 0); } finally { other.close(); }
    policy = 'deny'; await assert.rejects(gateway.dispatchReviewed(request, review.reviewId, () => { calls++; }), /denied/);
    policy = 'allow'; assert.equal(await gateway.dispatchReviewed(request, review.reviewId, () => { calls++; return 'ok'; }), 'ok'); assert.equal(calls, 1);
    await assert.rejects(gateway.dispatchReviewed(request, review.reviewId, () => { calls++; }), /operation_already_dispatched/);
  } finally { gateway.close(); }
});
