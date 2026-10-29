import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request, type Server } from 'node:http';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer } from '../src/http/server.ts';

const tailnet = 'https://desk.tail0000.ts.net';
type Reply = { status: number; cookie: string | undefined };

/** A tailnet proxy (tailscale serve) reaches the loopback listener with the phone's Host and Origin. */
async function withServer(origins: string[] | undefined, fn: (call: (method: string, host: string, origin?: string) => Promise<Reply>) => Promise<void>) {
  const store = new TaskStore(':memory:', 'remote-test');
  const server: Server = createAssistantServer({ store, token: 'TEST-ONLY', profileId: 'remote-test', web: true, ...(origins ? { webOrigins: origins } : {}) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const call = (method: string, host: string, origin?: string) => new Promise<Reply>((resolve, reject) => {
    const body = method === 'POST' ? JSON.stringify({ token: 'TEST-ONLY' }) : '';
    const req = request({ host: '127.0.0.1', port, method, path: '/web/session', headers: { host: host.replace('{port}', String(port)), ...(origin ? { origin: origin.replace('{port}', String(port)) } : {}), 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0] }));
    });
    req.on('error', reject); req.end(body);
  });
  try { await fn(call); } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
}

test('a configured tailnet origin reaches the panel over HTTPS with a Secure session cookie', async () => withServer([tailnet], async call => {
  assert.equal((await call('GET', 'desk.tail0000.ts.net')).status, 401);
  const login = await call('POST', 'desk.tail0000.ts.net', tailnet);
  assert.equal(login.status, 200);
  assert.match(login.cookie!, /HttpOnly; SameSite=Strict; Secure;/);
  const local = await call('POST', '127.0.0.1:{port}', 'http://127.0.0.1:{port}');
  assert.equal(local.status, 200);
  assert.doesNotMatch(local.cookie!, /Secure/);
}));

test('unlisted hosts, mixed schemes and cross-origin posts stay forbidden', async () => withServer([tailnet], async call => {
  assert.equal((await call('GET', 'evil.tail0000.ts.net')).status, 403);
  assert.equal((await call('GET', 'localhost:{port}')).status, 403);
  assert.equal((await call('POST', 'desk.tail0000.ts.net', 'http://desk.tail0000.ts.net')).status, 403);
  assert.equal((await call('POST', 'desk.tail0000.ts.net', 'http://127.0.0.1:{port}')).status, 403);
  assert.equal((await call('POST', '127.0.0.1:{port}', tailnet)).status, 403);
}));

test('without configured origins the panel answers loopback only', async () => withServer(undefined, async call => {
  assert.equal((await call('GET', 'desk.tail0000.ts.net')).status, 403);
  assert.equal((await call('GET', '127.0.0.1:{port}')).status, 401);
}));
