import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer } from '../src/http/server.ts';

const token = 'test-secret';
const context = (sourceEventId: string) => ({ sessionId: 'session', channelId: 'channel', runId: 'run', sourceEventId, evidenceReference: 'evidence' });
const task = { version: 1, profileId: 'profile', taskId: "id/' OR 1=1", title: 'task', status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: 'source-1' };

test('HTTP boundary, metadata journey and persisted events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-http-'));
  const path = join(dir, 'store.db');
  let store = new TaskStore(path, 'profile');
  assert.throws(() => createAssistantServer({ store, token, profileId: 'other' }));
  let server = createAssistantServer({ store, token, profileId: 'profile' });
  const listen = async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as any).port}`; };
  let base = await listen();
  const request = async (route: string, options: RequestInit = {}) => {
    const response = await fetch(base + route, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
    return { status: response.status, body: await response.text() };
  };
  const post = (route: string, body: unknown) => request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const id = encodeURIComponent(task.taskId);
  try {
    assert.equal((await request('/v1/tasks', { headers: { authorization: '' } })).status, 401);
    assert.equal((await request('/v1/tasks', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await request('/v1/tasks', { headers: { origin: 'https://example.test' } })).status, 403);
    assert.equal((await request('/v1/tasks', { method: 'POST', body: '{}' })).status, 400);
    assert.equal((await request('/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await request('/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(65537) })).status, 400);
    assert.equal((await post('/v1/tasks', { task, context: { ...context('source-1'), sourceKind: 'trusted-local-human' } })).status, 400);
    assert.equal((await post('/v1/tasks', { task, context: { ...context('source-1'), profileId: 'other' } })).status, 400);
    assert.equal((await post('/v1/tasks', { task: { ...task, profileId: 'other' }, context: context('source-1') })).status, 400);
    assert.equal((await post('/v1/tasks', { task, context: context('wrong') })).status, 400);
    assert.equal((await post('/v1/tasks', { task, context: context('source-1') })).status, 200);
    assert.equal((await post(`/v1/tasks/${id}/transition`, { expectedRevision: 1, nextStatus: 'working', context: context('source-1') })).status, 409);
    assert.equal((await post(`/v1/tasks/${id}/transition`, { expectedRevision: 1, nextStatus: 'working', context: context('source-2') })).status, 200);
    assert.equal((await post(`/v1/tasks/${id}/transition`, { expectedRevision: 2, nextStatus: 'needs_input', context: context('source-3') })).status, 200);
    const response = { version: 1, profileId: 'profile', taskId: task.taskId, revision: 3, inputRevision: 2, text: 'PRIVATE-RESPONSE' };
    assert.equal((await post('/v1/tasks/wrong/respond', { response, context: context('source-4') })).status, 400);
    assert.equal((await post(`/v1/tasks/${id}/respond`, { response: { ...response, profileId: 'other' }, context: context('source-4') })).status, 400);
    assert.equal((await post(`/v1/tasks/${id}/respond`, { response: { ...response, revision: 2 }, context: context('source-4') })).status, 409);
    assert.equal((await post(`/v1/tasks/${id}/respond`, { response, context: context('source-4') })).status, 200);
    const duplicate = await post(`/v1/tasks/${id}/respond`, { response, context: context('source-4') });
    assert.equal(duplicate.status, 409); assert.doesNotMatch(duplicate.body, /PRIVATE-RESPONSE/);
    assert.equal((await post(`/v1/tasks/${id}/transition`, { expectedRevision: 4, nextStatus: 'succeeded', context: context('source-5') })).status, 200);
    const events = await request('/v1/events?after=0&limit=10');
    assert.doesNotMatch(events.body, /PRIVATE-RESPONSE/);
    const parsed = JSON.parse(events.body); assert.equal(parsed.length, 5);
    assert.ok(parsed.every((item: any) => item.event.source.sourceKind === 'model' && item.event.source.actorId === 'assistant-client' && item.event.evidence.reference === 'evidence'));
    assert.equal((await request('/v1/tasks?profileId=other')).status, 400);
    assert.equal((await request('/v1/tasks/missing')).status, 404);
    assert.equal((await request('/v1/tasks/%ZZ')).status, 400);
    assert.equal((await request('/v1/events?limit=101')).status, 400);
    assert.equal((await request('/v1/tasks', { method: 'DELETE' })).status, 404);
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    store = new TaskStore(path, 'profile'); server = createAssistantServer({ store, token, profileId: 'profile' }); base = await listen();
    assert.equal(JSON.parse((await request(`/v1/tasks/${id}`)).body).status, 'succeeded');
    assert.equal(JSON.parse((await request('/v1/tasks?limit=1')).body).tasks.length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('auth and provenance guards resist disposable mutations', { skip: process.env.HTTP_MUTATION_CHILD === '1' }, () => {
  const original = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = mkdtempSync(join(tmpdir(), 'http-mutations-'));
  const variants = [
    ["if (!authenticate(req.headers.authorization, token))", "if (false)"],
    ["try { object(value, schema); }", "try { const input = value as any; if (input?.context) { delete input.context.sourceKind; delete input.context.profileId; } object(value, schema); }"],
  ];
  try {
    for (const [index, [before, after]] of variants.entries()) {
      const copy = join(root, String(index));
      mkdirSync(join(copy, 'test'), { recursive: true });
      cpSync(join(original, 'src'), join(copy, 'src'), { recursive: true });
      cpSync(join(original, 'test', 'http.test.ts'), join(copy, 'test', 'http.test.ts'));
      cpSync(join(original, 'package.json'), join(copy, 'package.json'));
      const file = join(copy, 'src', 'http', 'server.ts');
      const source = readFileSync(file, 'utf8'); assert.ok(source.includes(before));
      writeFileSync(file, source.replace(before, after));
      const env = { ...process.env, HTTP_MUTATION_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ['--test', join(copy, 'test', 'http.test.ts')], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 1, result.stderr); assert.match(result.stdout, /AssertionError/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
