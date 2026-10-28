import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, parseEventSequence, sourceAuthority } from '../src/contracts/events.ts';
import { parseTask, parseAttempt, assertTaskTransition, parseTaskResponse } from '../src/contracts/tasks.ts';
import { parseApproval } from '../src/contracts/approvals.ts';
import { parseConnector } from '../src/contracts/connectors.ts';
import { parseArtifact } from '../src/contracts/artifacts.ts';

const source = { actorId: 'actor-a', sourceKind: 'external', sourceEventId: 'source-event-a' };
const event = { version: 1, eventId: 'event-a', profileId: 'profile-a', sessionId: 'session-a', channelId: 'channel-a', taskId: 'task-a', runId: 'run-a', source, observedAt: '2026-10-28T12:00:00Z', sequence: 1, correlationId: 'correlation-a', evidence: { kind: 'observed', reference: 'evidence-a' } };
const task = { version: 1, profileId: 'profile-a', taskId: 'task-a', status: 'needs_input', verification: 'not_verified', revision: 3, inputRevision: 2, sourceEventId: 'event-a' };

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
  assert.throws(() => parseConnector({ ...connector, effect: 'assumed_read' }));
  assert.throws(() => parseArtifact({ ...artifact, review: 'approved', surprise: true }));
});
