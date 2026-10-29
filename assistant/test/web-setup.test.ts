import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer } from '../src/http/server.ts';
import type { SetupComponent } from '../src/setup.ts';

const token = 'disposable-setup-test-token';
const components: SetupComponent[] = [
  { id: 'store', label: 'Tarefas', fix: 'Inicie o servi\ço', capabilities: ['tasks'], probe: async () => ({ kind: 'exercised', detail: 'ok', evidence: 'select', at: Date.now() }) },
  { id: 'google', label: 'Google', fix: 'Conecte a conta', capabilities: ['email-briefing'], probe: async () => ({ kind: 'missing', detail: 'N\ão conectado.' }) },
];

async function withServer(fn: (base: string, login: () => Promise<string>) => Promise<void>, setup?: () => SetupComponent[]) {
  const store = new TaskStore(':memory:', 'setup-test');
  const server = createAssistantServer({ store, token, profileId: 'setup-test', web: true, ...(setup ? { setup } : {}) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = async () => {
    const res = await fetch(`${base}/web/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    return res.headers.get('set-cookie')!.split(';')[0];
  };
  try { await fn(base, login); } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
}

test('setup status needs a browser session, is read-only and labels declined sources', async () => withServer(async (base, login) => {
  assert.equal((await fetch(`${base}/web/api/setup`)).status, 401);
  const cookie = await login();
  const res = await fetch(`${base}/web/api/setup?declined=google`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json() as { items: { id: string; status: string }[]; capabilities: { capability: string; available: boolean; reason: string }[] };
  assert.deepEqual(body.items.map(item => [item.id, item.status]), [['store', 'ready'], ['google', 'needs_setup']]);
  assert.equal(body.capabilities.find(cap => cap.capability === 'tasks')!.available, true);
  assert.match(body.capabilities.find(cap => cap.capability === 'email-briefing')!.reason, /Agora n\ão/);
  assert.equal((await fetch(`${base}/web/api/setup?declined=../x`, { headers: { cookie } })).status, 400);
  assert.equal((await fetch(`${base}/web/api/setup?other=1`, { headers: { cookie } })).status, 400);
  assert.equal((await fetch(`${base}/web/api/setup`, { method: 'POST', headers: { cookie, origin: base } })).status, 403, 'no CSRF, no write path');
}, () => components));

test('without a configured setup source the endpoint does not exist', async () => withServer(async (base, login) => {
  const cookie = await login();
  assert.equal((await fetch(`${base}/web/api/setup`, { headers: { cookie } })).status, 404);
}));
