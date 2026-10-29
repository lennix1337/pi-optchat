import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { text, strings } from '../src/contracts/validation.ts';
import { parseTask } from '../src/contracts/tasks.ts';
import { parseEvent } from '../src/contracts/events.ts';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer } from '../src/http/server.ts';

const malformed = ['a\ud800b', 'a\ud800', 'a\udc00b', 'a\udc00'];
const valid = ['opaque/\' ID', 'café', 'task-😀', 'a\ud83d\ude00b'];
const task = { version: 1, profileId: 'profile', taskId: 'task', title: 'title', status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: 'source' };
const event = { version: 1, eventId: 'event', profileId: 'profile', sessionId: 'session', channelId: 'channel', taskId: 'task', runId: 'run', source: { actorId: 'actor', sourceKind: 'model', sourceEventId: 'source' }, observedAt: '2026-10-28T12:00:00Z', sequence: 1, correlationId: 'correlation', evidence: { kind: 'observed', reference: 'evidence' } };

test('text boundaries reject unpaired surrogates without changing valid strings', () => {
  for (const value of malformed) {
    const source = JSON.parse(JSON.stringify(value));
    assert.equal(source, value);
    assert.equal(text(source), false);
    assert.equal(strings([source]), false);
    assert.throws(() => parseTask({ ...task, taskId: source }), /contract\.taskId/);
    assert.throws(() => parseTask({ ...task, title: source }), /contract\.title/);
    assert.throws(() => parseEvent({ ...event, evidence: { ...event.evidence, reference: source } }), /contract\.evidence\.reference/);
  }
  for (const value of valid) {
    assert.equal(text(value), true);
    assert.equal(strings([value]), true);
    assert.equal(parseTask({ ...task, taskId: value, title: value }).taskId, value);
    assert.equal(parseEvent({ ...event, evidence: { ...event.evidence, reference: value } }).evidence.reference, value);
  }
});

test('HTTP rejects malformed task IDs before SQLite insert and valid IDs remain addressable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-unicode-'));
  const path = join(dir, 'store.db');
  const store = new TaskStore(path, 'profile');
  const observer = new DatabaseSync(path);
  const server = createAssistantServer({ store, token: 'test-secret', profileId: 'profile' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (route: string, options: RequestInit = {}) => fetch(base + route, { ...options, headers: { authorization: 'Bearer test-secret', ...options.headers } });
  const post = (id: string, source: string) => request('/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: { ...task, taskId: id, sourceEventId: source }, context: { sessionId: 'session', channelId: 'channel', runId: 'run', sourceEventId: source, evidenceReference: 'evidence' } }) });
  try {
    for (const id of malformed) {
      assert.equal(JSON.parse(JSON.stringify(id)), id);
      assert.equal((await post(id, 'bad-source')).status, 400);
      assert.equal(observer.prepare('SELECT count(*) AS count FROM tasks').get()!.count, 0);
    }
    const ids = ['ordinary/opaque', 'emoji-😀'];
    for (const [index, id] of ids.entries()) assert.equal((await post(id, `source-${index}`)).status, 200);
    const response = await request('/v1/tasks');
    assert.equal(response.status, 200);
    const listed = (await response.json() as { tasks: { taskId: string }[] }).tasks;
    assert.deepEqual(new Set(listed.map(item => item.taskId)), new Set(ids));
    for (const item of listed) {
      const detail = await request(`/v1/tasks/${encodeURIComponent(item.taskId)}`);
      assert.equal(detail.status, 200);
      assert.equal((await detail.json() as { taskId: string }).taskId, item.taskId);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    observer.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
