import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer } from '../src/http/server.ts';

async function clockFixture(fn: (f: { base: string; advance: (ms: number) => void; login: (cookie?: string, token?: string) => Promise<Response> }) => Promise<void>) {
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  const store = new TaskStore(':memory:', 'session-test');
  const server = createAssistantServer({ store, token: 'TEST-ONLY', profileId: 'session-test', web: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = (cookie = '', token = 'TEST-ONLY') => fetch(`${base}/web/session`, { method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  try { await fn({ base, advance: ms => { now += ms; }, login }); }
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
