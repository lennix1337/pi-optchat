import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer } from '../src/http/server.ts';
import type { Event } from '../src/contracts/events.ts';

const token = 'disposable-web-test-token';
async function fixture(fn: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await fn(f); } finally { await new Promise<void>(resolve => f.server.close(() => resolve())); f.store.close(); }
}
async function setup() {
  const store = new TaskStore(':memory:', 'panel-test');
  const server = createAssistantServer({ store, token, profileId: 'panel-test', web: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, options: RequestInit = {}) => fetch(base + path, options);
  const login = async () => {
    const res = await request('/web/session', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await res.json() as { csrf: string };
    return { cookie, csrf };
  };
  return { store, server, base, request, login };
}
function event(store: TaskStore, taskId: string): Event {
  return { version: 1, eventId: randomUUID(), correlationId: randomUUID(), profileId: 'panel-test', taskId, sessionId: 'worker-session', channelId: 'test-channel', runId: 'test-run', source: { actorId: 'fixture-worker', sourceKind: 'worker', sourceEventId: randomUUID() }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), evidence: { kind: 'observed', reference: 'optchat://test/original/7' } };
}

test('web assets have restrictive headers, no credentials, path traversal or inline scripts', async () => fixture(async f => {
  for (const path of ['/', '/app/app.js', '/app/state.js', '/app/app.css']) {
    const res = await f.request(path); assert.equal(res.status, 200, path);
    const body = await res.text(); assert.doesNotMatch(body, /disposable-web-test-token/);
    assert.match(res.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    if (path === '/') { assert.match(body, /lang="pt-BR"/); assert.doesNotMatch(body, /<script(?![^>]*src=)/); }
  }
  assert.equal((await f.request('/app/unknown')).status, 404);
  assert.equal((await f.request('/app/%2e%2e%2fpackage.json')).status, 404);
  assert.equal((await f.request('/web/api/tasks')).status, 401);
  assert.equal((await f.request('/web/api/tasks', { headers: { authorization: `Bearer ${token}` } })).status, 401);
}));

test('cookie plus same-origin CSRF, not bearer, gates browser mutations and logout revokes', async () => fixture(async f => {
  const body = JSON.stringify({ requestId: randomUUID(), title: 'Tarefa local', channelId: 'Pessoal' });
  const headers = { 'content-type': 'application/json', origin: f.base };
  assert.equal((await f.request('/web/session', { method: 'POST', headers: { ...headers, origin: 'https://foreign.test' }, body: JSON.stringify({ token }) })).status, 403);
  const session = await f.login();
  for (const extra of [{}, { 'x-assistant-csrf': 'wrong' }, { 'x-assistant-csrf': session.csrf, origin: 'https://foreign.test' }, { 'x-assistant-csrf': session.csrf, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.request('/web/api/tasks', { method: 'POST', headers: { ...headers, cookie: session.cookie, ...extra }, body })).status, 403);
  }
  assert.deepEqual(f.store.list().tasks, []);
  const res = await f.request('/web/api/tasks', { method: 'POST', headers: { ...headers, cookie: session.cookie, 'x-assistant-csrf': session.csrf }, body });
  assert.equal(res.status, 200);
  const task = await res.json() as { taskId: string };
  assert.equal(f.store.get(task.taskId)?.title, 'Tarefa local');
  // A web credential proves channel access, not a locally typed approval.
  assert.equal(f.store.events()[0].event.source.sourceKind, 'external');
  assert.equal((await f.request('/web/session/logout', { method: 'POST', headers: { ...headers, cookie: session.cookie, 'x-assistant-csrf': session.csrf } })).status, 200);
  assert.equal((await f.request('/web/api/tasks', { headers: { cookie: session.cookie } })).status, 401);
}));

test('current input, replay conflict, review, resolution and evidence use the same persisted task', async () => fixture(async f => {
  const session = await f.login();
  const headers = { origin: f.base, cookie: session.cookie, 'x-assistant-csrf': session.csrf, 'content-type': 'application/json' };
  const post = (path: string, input: object) => f.request(path, { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), channelId: 'Pessoal', ...input }) });
  const created = await post('/web/api/tasks', { title: 'Revisar entrega <script>alert(1)</script>' });
  const task = await created.json() as { taskId: string };
  const id = encodeURIComponent(task.taskId);
  f.store.transition(task.taskId, 1, 'working', event(f.store, task.taskId));
  f.store.transition(task.taskId, 2, 'needs_input', event(f.store, task.taskId));
  const res = await post(`/web/api/tasks/${id}/respond`, { revision: 3, inputRevision: 2, text: 'PRIVATE-ANSWER-CANARY' });
  assert.equal(res.status, 200); assert.equal(f.store.get(task.taskId)?.status, 'working');
  const stale = await post(`/web/api/tasks/${id}/respond`, { revision: 3, inputRevision: 2, text: 'STALE-ANSWER' });
  assert.equal(stale.status, 409); assert.equal((await stale.json() as any).task.revision, 4);
  f.store.transition(task.taskId, 4, 'ready_for_review', event(f.store, task.taskId));
  assert.equal((await post(`/web/api/tasks/${id}/transition`, { expectedRevision: 5, nextStatus: 'succeeded' })).status, 200);
  assert.equal((await post(`/web/api/tasks/${id}/transition`, { expectedRevision: 6, nextStatus: 'resolved' })).status, 200);
  const snapshot = f.store.get(task.taskId); assert.equal(snapshot?.status, 'resolved'); assert.equal(snapshot?.verification, 'not_verified');
  const evidence = await f.request('/web/api/events?after=2&limit=2', { headers: { cookie: session.cookie } });
  const text = await evidence.text(); const entries = JSON.parse(text);
  assert.deepEqual(entries.map((item: any) => item.event.sequence), [3, 4]);
  assert.doesNotMatch(text, /PRIVATE-ANSWER-CANARY|STALE-ANSWER/);
  assert.equal(entries[0].event.evidence.reference, 'optchat://test/original/7');
  const before = f.store.events().length;
  await f.request('/web/api/events?after=0', { headers: { cookie: session.cookie } });
  assert.equal(f.store.events().length, before, 'inspection must be read-only');
}));

test('malformed and privileged requests fail closed, no journal changes', async () => fixture(async f => {
  const session = await f.login();
  const headers = { cookie: session.cookie, origin: f.base, 'x-assistant-csrf': session.csrf, 'content-type': 'application/json' };
  for (const extra of [{ sourceKind: 'trusted-local-human' }, { profileId: 'foreign' }, { verification: 'verified' }, { title: '   ' }]) {
    const res = await f.request('/web/api/tasks', { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), title: 'Allowed title', channelId: 'Pessoal', ...extra }) });
    assert.equal(res.status, 400); assert.match(res.headers.get('content-security-policy')!, /default-src 'none'/);
  }
  for (const path of ['/web/api/tasks?profileId=foreign', '/web/api/events?after=-1', '/web/api/events?limit=101', '/web/api/tasks?limit=1&limit=2']) {
    assert.equal((await f.request(path, { headers })).status, 400);
  }
  assert.deepEqual(f.store.events(), []);
}));

test('task create replay is a conflict, never a second task', async () => fixture(async f => {
  const session = await f.login();
  const headers = { cookie: session.cookie, origin: f.base, 'x-assistant-csrf': session.csrf, 'content-type': 'application/json' };
  const body = JSON.stringify({ requestId: randomUUID(), title: 'Once', channelId: 'Pessoal' });
  const post = () => f.request('/web/api/tasks', { method: 'POST', headers, body });
  assert.equal((await post()).status, 200); assert.equal((await post()).status, 409);
  assert.equal(f.store.list().tasks.length, 1);
}));
