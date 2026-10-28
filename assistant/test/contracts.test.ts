import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, parseEventSequence, sourceAuthority } from '../src/contracts/events.ts';
import { parseTask, parseAttempt, assertTaskTransition, parseTaskResponse } from '../src/contracts/tasks.ts';
import { parseApproval } from '../src/contracts/approvals.ts';
import { parseConnector } from '../src/contracts/connectors.ts';
import { parseArtifact } from '../src/contracts/artifacts.ts';
import { object } from '../src/contracts/validation.ts';

const source = { actorId: 'actor-a', sourceKind: 'external', sourceEventId: 'source-event-a' };
const event = { version: 1, eventId: 'event-a', profileId: 'profile-a', sessionId: 'session-a', channelId: 'channel-a', taskId: 'task-a', runId: 'run-a', source, observedAt: '2026-10-28T12:00:00Z', sequence: 1, correlationId: 'correlation-a', evidence: { kind: 'observed', reference: 'evidence-a' } };
const task = { version: 1, profileId: 'profile-a', taskId: 'task-a', title: 'Review plan', status: 'needs_input', verification: 'not_verified', revision: 3, inputRevision: 2, sourceEventId: 'event-a' };

test('event boundary requires supported version, source and ordered profile-local sequence', () => {
  assert.deepEqual(parseEvent(event), event);
  assert.deepEqual(parseEventSequence([event, { ...event, eventId: 'event-b', sequence: 2 }], 'profile-a', 0).map(e => e.sequence), [1, 2]);
  for (const invalid of [{ ...event, version: 2 }, { ...event, sequence: 0 }, { ...event, extra: true }, { ...event, source: { ...source, sourceKind: 'unknown' } }, { ...event, evidence: { kind: 'verified', reference: 'x', verifiedBy: 'x' } }]) assert.throws(() => parseEvent(invalid));
  assert.throws(() => parseEventSequence([event], 'profile-b', 0));
  assert.throws(() => parseEventSequence([{ ...event, sequence: 2 }], 'profile-a', 0));
});

test('source authority is fixed and does not confer effects', () => {
  assert.equal(sourceAuthority('trusted-local-human'), 'human_intent');
  for (const kind of ['external', 'worker', 'model']) assert.equal(sourceAuthority(kind), 'untrusted');
  assert.throws(() => sourceAuthority('unknown'));
  assert.throws(() => parseEvent({ ...event, source: { ...source, authority: 'human_intent' } }));
});

test('task transition and response enforce profile, revisions and input freshness', () => {
  assert.deepEqual(parseTask(task), task);
  assertTaskTransition(task, 'working', 'profile-a', 3);
  assert.throws(() => assertTaskTransition(task, 'succeeded', 'profile-a', 3));
  assert.throws(() => assertTaskTransition(task, 'working', 'profile-b', 3));
  assert.throws(() => assertTaskTransition(task, 'working', 'profile-a', 2));
  const response = { version: 1, profileId: 'profile-a', taskId: 'task-a', revision: 3, inputRevision: 2, text: 'answer' };
  assert.deepEqual(parseTaskResponse(response, task), response);
  for (const change of [{ profileId: 'profile-b' }, { taskId: 'other' }, { revision: 2 }, { inputRevision: 1 }]) assert.throws(() => parseTaskResponse({ ...response, ...change }, task));
  assert.throws(() => parseTaskResponse(response, { ...task, status: 'resolved' }));
  assert.equal(parseTask({ ...task, status: 'resolved', verification: 'not_verified' }).verification, 'not_verified');
  const attempt = { version: 1, profileId: 'profile-a', taskId: 'task-a', runId: 'run-a', status: 'effect_uncertain' };
  assert.deepEqual(parseAttempt(attempt), attempt);
  assert.throws(() => parseAttempt({ ...attempt, status: 'retry' }));
});

test('approval, connector and artifact shapes reject unknown or incomplete boundary data', () => {
  const approval = { version: 1, approvalId: 'approval-a', profileId: 'profile-a', taskId: 'task-a', runId: 'run-a', accountId: 'account-a', effect: 'send', destination: 'destination-a', contentHash: 'sha256:abc', expiresAt: '2026-10-28T13:00:00Z', policyVersion: 'policy-a', ownerId: 'owner-a', scope: 'once' };
  const connector = { version: 1, connectorId: 'connector-a', profileId: 'profile-a', accountId: 'account-a', serverId: 'server-a', schemaHash: 'sha256:def', grantedCapabilities: ['read'], effect: 'unknown', secretRef: 'secret-a' };
  const artifact = { version: 1, artifactId: 'artifact-a', profileId: 'profile-a', ownerId: 'owner-a', type: 'html', artifactVersion: 1, hash: 'sha256:ghi', producerId: 'producer-a', location: 'location-a', provenance: 'event-a', review: 'not_reviewed' };
  assert.deepEqual(parseApproval(approval), approval);
  assert.deepEqual(parseConnector(connector), connector);
  assert.deepEqual(parseArtifact(artifact), artifact);
  assert.throws(() => parseApproval({ ...approval, scope: 'rule' }));
  assert.throws(() => parseApproval({ ...approval, expiresAt: '2026-02-31T12:00:00Z' }), /contract\.expiresAt/);
  assert.throws(() => parseConnector({ ...connector, effect: 'assumed_read' }));
  assert.throws(() => parseArtifact({ ...artifact, review: 'approved', surprise: true }));
});

test('task title is required nonempty display metadata', () => {
  const { title, ...missingTitle } = task;
  assert.throws(() => parseTask(missingTitle), /contract.title/);
  assert.throws(() => parseTask({ ...task, title: '  ' }));
  assert.equal(parseTask({ ...task, title: 'Review plan' }).title, 'Review plan');
});

test('timestamps must be real canonical UTC calendar values', () => {
  for (const observedAt of ['2026-02-31T12:00:00Z', '2025-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00.1Z', '2026-13-01T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+00:00']) {
    assert.throws(() => parseEvent({ ...event, observedAt }), observedAt);
  }
  for (const observedAt of ['2024-02-29T23:59:59Z', '2026-12-31T23:59:59.999Z']) {
    assert.equal(parseEvent({ ...event, observedAt }).observedAt, observedAt);
  }
});


test('nested validation identifies fields and preserves programming errors', () => {
  assert.throws(() => parseEvent({ ...event, source: { ...source, sourceKind: 'bad' } }), /contract\.source\.sourceKind/);
  assert.throws(() => parseEvent({ ...event, evidence: { kind: 'observed' } }), /contract\.evidence\.reference/);
  const error = new Error('rule bug');
  assert.throws(() => object({ nested: { field: 'x' } }, { nested: { field: () => { throw error; } } }), value => value === error);
});
