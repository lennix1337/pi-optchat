import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseTask, parseAttempt, parseTaskResponse } from '../src/contracts/tasks.ts';
import { parseEvent } from '../src/contracts/events.ts';
import { parseApproval } from '../src/contracts/approvals.ts';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer } from '../src/http/server.ts';

const task = { version: 1, profileId: 'profile', taskId: 'id', title: 'task', status: 'needs_input', verification: 'not_verified', revision: 3, inputRevision: 2, sourceEventId: 'source' };
const approval = { version: 1, approvalId: 'approval', profileId: 'profile', taskId: 'id', runId: 'run', accountId: 'account', effect: 'write', destination: 'destination', contentHash: 'hash', expiresAt: '2026-10-28T12:00:00Z', policyVersion: '1', ownerId: 'owner', scope: 'once' };
const response = { version: 1, profileId: 'profile', taskId: 'id', revision: 3, inputRevision: 2, text: 'answer' };
const attempt = { version: 1, profileId: 'profile', taskId: 'id', runId: 'run', status: 'planned' };
const event = { version: 1, eventId: 'event', profileId: 'profile', sessionId: 'session', channelId: 'channel', taskId: 'id', runId: 'run', source: { actorId: 'actor', sourceKind: 'model', sourceEventId: 'source' }, observedAt: '2026-10-28T12:00:00Z', sequence: 1, correlationId: 'correlation', evidence: { kind: 'observed', reference: 'evidence' } };
const validIds = ['a/b', 'space id', "id/' OR 1=1", 'emoji-😀', 'a.b', '...', ' . ', './x'];

test('task ID contracts reject exact dot segments and preserve opaque IDs', () => {
  for (const id of ['.', '..']) {
    assert.throws(() => parseTask({ ...task, taskId: id }), /contract\.taskId/);
    assert.throws(() => parseAttempt({ ...attempt, taskId: id }), /contract\.taskId/);
    assert.throws(() => parseApproval({ ...approval, taskId: id }), /contract\.taskId/);
    assert.throws(() => parseEvent({ ...event, taskId: id }), /contract\.taskId/);
    assert.throws(() => parseTaskResponse({ ...response, taskId: id }, task), /contract\.taskId/);
  }
  for (const id of validIds) {
    assert.equal(parseTask({ ...task, taskId: id }).taskId, id);
    assert.equal(parseAttempt({ ...attempt, taskId: id }).taskId, id);
    assert.equal(parseApproval({ ...approval, taskId: id }).taskId, id);
    assert.equal(parseEvent({ ...event, taskId: id }).taskId, id);
    assert.equal(parseTaskResponse({ ...response, taskId: id }, { ...task, taskId: id }).taskId, id);
  }
  assert.equal(parseTask({ ...task, profileId: '.', sourceEventId: '..' }).profileId, '.');
  assert.equal(parseEvent({ ...event, eventId: '..', runId: '.' }).eventId, '..');
});

test('create refuses dot IDs without writes; opaque IDs round-trip through encoded routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-task-ids-'));
  const path = join(dir, 'store.db');
  const store = new TaskStore(path, 'profile');
  const observer = new DatabaseSync(path);
  const server = createAssistantServer({ store, token: 'secret', profileId: 'profile' });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const request = (route: string, body?: unknown) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer secret', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const context = (sourceEventId: string) => ({ sessionId: 'session', channelId: 'channel', runId: 'run', sourceEventId, evidenceReference: 'evidence' });
    for (const id of ['.', '..']) {
      const source = `invalid-${id}`;
      const result = await request('/v1/tasks', { task: { ...task, taskId: id, status: 'queued', revision: 1, inputRevision: 1, sourceEventId: source }, context: context(source) });
      assert.equal(result.status, 400, id);
      assert.equal(observer.prepare('SELECT count(*) AS n FROM tasks').get()!.n, 0);
      assert.equal(observer.prepare('SELECT count(*) AS n FROM events').get()!.n, 0);
    }
    for (const [index, id] of validIds.entries()) {
      const source = `create-${index}`;
      const route = `/v1/tasks/${encodeURIComponent(id)}`;
      assert.equal((await request('/v1/tasks', { task: { ...task, taskId: id, status: 'queued', revision: 1, inputRevision: 1, sourceEventId: source }, context: context(source) })).status, 200, id);
      const fetched = await request(route);
      assert.equal(fetched.status, 200, id);
      assert.equal((await fetched.json() as typeof task).taskId, id);
      assert.equal((await request(`${route}/transition`, { expectedRevision: 1, nextStatus: 'working', context: context(`working-${index}`) })).status, 200, id);
      assert.equal((await request(`${route}/transition`, { expectedRevision: 2, nextStatus: 'needs_input', context: context(`input-${index}`) })).status, 200, id);
      assert.equal((await request(`${route}/respond`, { response: { ...response, taskId: id }, context: context(`response-${index}`) })).status, 200, id);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    observer.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
