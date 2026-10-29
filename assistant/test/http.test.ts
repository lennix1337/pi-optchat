import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { connect } from 'node:net';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer, isAllowedRemote } from '../src/http/server.ts';

const token = 'test-secret';
const context = (sourceEventId: string) => ({ sessionId: 'session', channelId: 'channel', runId: 'run', sourceEventId, evidenceReference: 'evidence' });
const task = { version: 1, profileId: 'profile', taskId: "id/' OR 1=1", title: 'task', status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: 'source-1' };

test('HTTP boundary, metadata journey and persisted events', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-http-'));
  const path = join(dir, 'store.db');
  let store = new TaskStore(path, 'profile');
  assert.throws(() => createAssistantServer({ store, token, profileId: 'other' }));
  const calls: unknown[][] = [];
  const poster = { send: async (...args: unknown[]) => { calls.push(args); return { ok: true }; } };
  let server = createAssistantServer({ store, token, profileId: 'profile', slack: { relay: {} as any, poster: poster as any, channels: { project: 'C1' } } });
  const listen = async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as any).port}`; };
  let base = await listen();
  const request = async (route: string, options: RequestInit = {}) => {
    const response = await fetch(base + route, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
    return { status: response.status, body: await response.text() };
  };
  const post = (route: string, body: unknown) => request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const id = encodeURIComponent(task.taskId);
  try {
    await t.test('Slack send admits only valid optional fields and refuses malformed shapes before posting', async () => {
      for (const body of [null, [], { text: 'x', threadTs: null, extra: true }, { text: 'x', threadTs: null, approval: 'yes' }, { text: 'x', threadTs: null, channel: '__proto__' }, { text: 'x', threadTs: null, channel: null }, { text: 'x' }]) {
        assert.equal((await post('/v1/slack/send', body)).status, 400, `reject ${JSON.stringify(body)}`);
      }
      assert.equal((await request('/v1/slack/send', { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', threadTs: null }) })).status, 401);
      assert.equal(calls.length, 0);
      assert.equal((await post('/v1/slack/send', { text: 'x', threadTs: null })).status, 200);
      assert.equal((await post('/v1/slack/send', { text: 'y', threadTs: '123.45', channel: 'project', approval: true })).status, 200, 'accept valid optional fields');
      assert.deepEqual(calls, [['x', undefined, undefined, { approval: false }], ['y', '123.45', 'project', { approval: true }]]);
    });
    assert.equal((await request('/v1/tasks', { headers: { authorization: '' } })).status, 401);
    assert.equal((await request('/v1/tasks', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await request('/v1/tasks', { headers: { origin: 'https://example.test' } })).status, 403);
    assert.equal((await request('/v1/tasks', { method: 'POST', body: '{}' })).status, 400);
    assert.equal((await request('/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
    const oversized = await request('/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(65537) }).catch(() => null);
    if (oversized) assert.equal(oversized.status, 400);
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
    assert.equal((await request('/v1/events?limit=1&limit=2')).status, 400);
    assert.equal((await request('/v1/events?after=-1')).status, 400);
    assert.equal((await request('/v1/tasks?cursor=')).status, 400);
    assert.equal((await request('/v1/tasks', { method: 'DELETE' })).status, 404);
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    store = new TaskStore(path, 'profile'); server = createAssistantServer({ store, token, profileId: 'profile' }); base = await listen();
    assert.equal(JSON.parse((await request(`/v1/tasks/${id}`)).body).status, 'succeeded');
    assert.equal(JSON.parse((await request('/v1/tasks?limit=1')).body).tasks.length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the draft executor status is an authenticated read, absent when the executor is off', async () => {
  const store = new TaskStore(':memory:', 'profile');
  const status = { state: 'running' as const, failing: true, lastError: 'database is locked', lastErrorAt: '2026-10-29T12:00:00.000Z' };
  const servers = [createAssistantServer({ store, token, profileId: 'profile', executor: () => status }), createAssistantServer({ store, token, profileId: 'profile' })];
  try {
    const [on, off] = await Promise.all(servers.map(async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as any).port}`; }));
    const read = (base: string, auth = `Bearer ${token}`) => fetch(`${base}/v1/executor`, { headers: { authorization: auth } });
    assert.equal((await read(on!, 'Bearer wrong')).status, 401);
    assert.deepEqual(await (await read(on!)).json(), status);
    assert.equal((await read(off!)).status, 404);
  } finally { for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test('non-loopback address is refused by handler guard', async () => {
  assert.equal(isAllowedRemote('127.0.0.1'), true);
  assert.equal(isAllowedRemote('::1'), true);
  assert.equal(isAllowedRemote('::ffff:127.0.0.1'), true);
  assert.equal(isAllowedRemote('127.0.0.2'), false);
  assert.equal(isAllowedRemote(undefined), false);
  const store = new TaskStore(':memory:', 'profile');
  const server = createAssistantServer({ store, token, profileId: 'profile' });
  server.prependListener('request', req => { Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.1' }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/tasks`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test('incomplete oversized and stalled bodies close promptly without mutation', async () => {
  const store = new TaskStore(':memory:', 'profile');
  const server = createAssistantServer({ store, token, profileId: 'profile' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port;
  const probe = async (body: string, timeout: number, trickle = false) => {
    const socket = connect({ host: '127.0.0.1', port });
    let received = '';
    socket.on('data', data => { received += data.toString(); });
    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('body refusal timed out')); }, timeout);
      socket.once('error', () => {});
      socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
    await once(socket, 'connect');
    socket.write(`POST /v1/tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n${body}`);
    const interval = trickle ? setInterval(() => socket.write('x'), 500) : undefined;
    try { await closed; } finally { if (interval) clearInterval(interval); }
    assert.ok(!received || received.startsWith('HTTP/1.1 400 '));
  };
  try {
    await probe('x'.repeat(65537), 1500); await probe('{', 4000); await probe('{', 7000, true);
    const disconnected = connect({ host: '127.0.0.1', port }); await once(disconnected, 'connect');
    disconnected.write(`POST /v1/tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{`);
    disconnected.destroy(); await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(store.list().tasks, []);
  }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test('closed SQLite yields one safe diagnostic and 500', async () => {
  const store = new TaskStore(':memory:', 'profile');
  const diagnostics: unknown[] = [];
  const server = createAssistantServer({ store, token, profileId: 'profile', onError: diagnostic => { diagnostics.push(diagnostic); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); store.close();
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/tasks?cursor=PRIVATE-RESPONSE`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 500); assert.equal(await response.text(), '{"error":"Internal error"}');
    assert.deepEqual(diagnostics, [{ category: 'internal', operation: 'request' }]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE-RESPONSE|test-secret|SQLITE|stack/i);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('failed diagnostic observers cannot leak or cause unhandled rejections', async () => {
  const logs: string[] = []; const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    for (const onError of [() => { throw new Error('PRIVATE-RESPONSE'); }, async () => { throw new Error('PRIVATE-RESPONSE'); }, undefined]) {
      const store = new TaskStore(':memory:', 'profile');
      const server = createAssistantServer({ store, token, profileId: 'profile', onError });
      server.listen(0, '127.0.0.1'); await once(server, 'listening'); store.close();
      try {
        const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/tasks`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(response.status, 500); await response.text();
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    }
    assert.deepEqual(logs, ['assistant HTTP diagnostic observer failed', 'assistant HTTP diagnostic observer failed', 'assistant HTTP internal request failure']);
  } finally { console.error = original; }
});

test('Slack optional field admission resists disposable mutations', { skip: process.env.HTTP_MUTATION_CHILD === '1' }, () => {
  const original = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = mkdtempSync(join(tmpdir(), 'http-slack-mutations-'));
  const variants = [
    ['channel validation', 'channel: known', 'channel: () => true', /reject .*"channel":"__proto__"/, /200 !== 400/],
    ['approval validation', "approval: (v: unknown) => typeof v === 'boolean'", 'approval: () => true', /reject .*"approval":"yes"/, /200 !== 400/],
    ['channel selection', 'channel: known, ', '', /accept valid optional fields/, /400 !== 200/],
    ['approval selection', ", approval: (v: unknown) => typeof v === 'boolean'", '', /accept valid optional fields/, /400 !== 200/],
  ] as const;
  try {
    const copy = join(root, 'assistant');
    mkdirSync(join(copy, 'test'), { recursive: true });
    cpSync(join(original, 'src'), join(copy, 'src'), { recursive: true });
    cpSync(join(original, 'test', 'http.test.ts'), join(copy, 'test', 'http.test.ts'));
    cpSync(join(original, 'package.json'), join(copy, 'package.json'));
    const file = join(copy, 'src', 'http', 'server.ts');
    const source = readFileSync(file, 'utf8');
    const env = { ...process.env, HTTP_MUTATION_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
    const run = () => spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=HTTP boundary|Slack send admits', join(copy, 'test', 'http.test.ts')], { env, encoding: 'utf8', timeout: 15000 });
    const baseline = run();
    assert.equal(baseline.error, undefined); assert.equal(baseline.signal, null); assert.equal(baseline.status, 0, baseline.stderr + baseline.stdout);
    for (const [name, before, after, assertion, expected] of variants) {
      assert.equal(source.split(before).length, 2, `${name}: mutation anchor must be unique`);
      writeFileSync(file, source.replace(before, after));
      const result = run();
      assert.equal(result.error, undefined, name); assert.equal(result.signal, null, name);
      assert.equal(result.status, 1, `${name}: ${result.stderr}${result.stdout}`);
      assert.match(result.stdout, /    not ok 1 - Slack send admits only valid optional fields and refuses malformed shapes before posting/);
      assert.match(result.stdout, assertion, name); assert.match(result.stdout, expected, name);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auth and provenance guards resist disposable mutations', { skip: process.env.HTTP_MUTATION_CHILD === '1' }, () => {
  const original = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = mkdtempSync(join(tmpdir(), 'http-mutations-'));
  const variants = [
    ['server.ts', "if (!authenticate(req.headers.authorization, token))", "if (false)", /200 !== 401/],
    ['io.ts', "try { object(value, schema); }", "try { const input = value as any; if (input?.context) { delete input.context.sourceKind; delete input.context.profileId; } object(value, schema); }", /200 !== 400/],
    ['server.ts', "if (req.headers.origin !== undefined)", "if (false)", /200 !== 403/],
    ['server.ts', " || !store.matchesProfile(profileId)", "", /Missing expected exception/],
    ['server.ts', "!isAllowedRemote(req.socket.remoteAddress)", "false", /200 !== 403/],
  ] as const;
  try {
    for (const [index, [target, before, after, expected]] of variants.entries()) {
      const copy = join(root, String(index));
      mkdirSync(join(copy, 'test'), { recursive: true });
      cpSync(join(original, 'src'), join(copy, 'src'), { recursive: true });
      cpSync(join(original, 'test', 'http.test.ts'), join(copy, 'test', 'http.test.ts'));
      cpSync(join(original, 'package.json'), join(copy, 'package.json'));
      const file = join(copy, 'src', 'http', target);
      const source = readFileSync(file, 'utf8'); assert.ok(source.includes(before));
      writeFileSync(file, source.replace(before, after));
      const env = { ...process.env, HTTP_MUTATION_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=HTTP boundary|non-loopback', join(copy, 'test', 'http.test.ts')], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 1, result.stderr); assert.match(result.stdout, expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
