import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer } from '../src/http/server.ts';

async function clockFixture(fn: (f: { base: string; server: Server; store: TaskStore; advance: (ms: number) => void; login: (cookie?: string, token?: string) => Promise<Response> }) => Promise<void>) {
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  const store = new TaskStore(':memory:', 'session-test');
  const server = createAssistantServer({ store, token: 'TEST-ONLY', profileId: 'session-test', web: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = (cookie = '', token = 'TEST-ONLY') => fetch(`${base}/web/session`, { method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  try { await fn({ base, server, store, advance: ms => { now += ms; }, login }); }
  finally { Date.now = originalNow; await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
}
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0];

test('web sessions expire by idle and absolute age, reauthentication rotates instead of fixing a session', async () => clockFixture(async f => {
  const first = await f.login(); const firstCookie = cookieOf(first);
  assert.match(first.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  const second = await f.login(firstCookie); const cookie = cookieOf(second);
  assert.notEqual(firstCookie, cookie);
  assert.equal((await fetch(`${f.base}/web/session`, { headers: { cookie: firstCookie } })).status, 401);
  const get = () => fetch(`${f.base}/web/session`, { headers: { cookie } });
  for (let hour = 0; hour < 12; hour++) { f.advance(3_600_000); assert.equal((await get()).status, 200); }
  f.advance(1); assert.equal((await get()).status, 401);
  const idle = cookieOf(await f.login()); f.advance(2 * 3_600_000 + 1);
  assert.equal((await fetch(`${f.base}/web/session`, { headers: { cookie: idle } })).status, 401);
}));

test('in-flight mutations cannot survive logout, rotation, or expiry', async () => {
  for (const revocation of ['logout', 'rotation', 'idle expiry', 'absolute expiry'] as const) await clockFixture(async f => {
    const login = await f.login(); const cookie = cookieOf(login);
    const { csrf } = await login.json() as { csrf: string };
    const body = JSON.stringify({ requestId: randomUUID(), title: 'Delayed', channelId: 'test' });
    const received = new Promise<void>(resolve => f.server.once('request', req => req.once('data', () => resolve())));
    const status = new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${f.base}/web/api/tasks`, { method: 'POST', headers: { origin: f.base, cookie, 'x-assistant-csrf': csrf, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
      req.once('error', reject);
      req.write(body.slice(0, 1));
      void (async () => {
        await received;
        if (revocation === 'logout') {
          assert.equal((await fetch(`${f.base}/web/session/logout`, { method: 'POST', headers: { origin: f.base, cookie, 'x-assistant-csrf': csrf } })).status, 200);
        } else if (revocation === 'rotation') {
          assert.equal((await f.login(cookie)).status, 200);
        } else if (revocation === 'idle expiry') {
          f.advance(2 * 3_600_000 + 1);
        } else {
          for (let hour = 0; hour < 12; hour++) {
            f.advance(3_600_000);
            assert.equal((await fetch(`${f.base}/web/session`, { headers: { cookie } })).status, 200);
          }
          f.advance(1);
        }
        req.end(body.slice(1));
      })().catch(error => { req.destroy(); reject(error); });
    });
    assert.equal(await status, 401, revocation);
    assert.equal(f.store.list(null, 100).tasks.length, 0, revocation);
    assert.equal(f.store.events(0, 100).length, 0, revocation);
  });
});

test('alternate loopback origins cannot serve a panel, authenticate or independently dispatch', async () => clockFixture(async f => {
  const session = await f.login(); const cookie = cookieOf(session);
  const { csrf } = await session.json() as { csrf: string };
  const port = new URL(f.base).port;
  for (const host of [`localhost:${port}`, `[::1]:${port}`, `127.0.0.2:${port}`]) {
    for (const path of ['/', '/app/app.js', '/web/session', '/web/api/tasks']) {
      const method = path.startsWith('/web/') ? 'POST' : 'GET';
      const body = path === '/web/session' ? { token: 'TEST-ONLY' } : { requestId: randomUUID(), title: 'Do not duplicate', channelId: 'test' };
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${f.base}${path}`, { method, headers: { host, origin: `http://${host}`, cookie, 'x-assistant-csrf': csrf, 'content-type': 'application/json' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
        req.once('error', reject); req.end(method === 'POST' ? JSON.stringify(body) : undefined);
      });
      assert.equal(status, 403, `${host}${path}`);
    }
  }
  assert.equal(f.store.events().length, 0);
  assert.equal(f.store.list().tasks.length, 0);
}));

test('wrong hosts, login floods and session storage are bounded', async () => clockFixture(async f => {
  // Native fetch replaces Host with the URL authority; exercise the raw HTTP boundary instead.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(f.base, { headers: { host: 'attacker.test' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.end();
  });
  assert.equal(status, 403);
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await f.login('', 'wrong')).status, 401);
  assert.equal((await f.login()).status, 429);
  f.advance(60_001);
  for (let i = 0; i < 32; i++) assert.equal((await f.login()).status, 200);
  assert.equal((await f.login()).status, 429);
  f.advance(2 * 3_600_000 + 1);
  assert.equal((await f.login()).status, 200, 'expired sessions must be reaped');
}));
