import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer } from '../src/http/server.ts';

// Only a stored fixture is exposed: the panel must not refresh Google implicitly.
test('stored briefing is profile-bound, read-only and withheld after session revocation', async () => {
  const store = new TaskStore(':memory:', 'briefing-panel');
  let reads = 0, refreshes = 0;
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  let value: unknown = { version: 1, profileId: 'briefing-panel', briefingId: 'b1', kind: 'daily', localDate: '2026-10-29', timeZone: 'UTC', createdAt: '2026-10-29T10:00:00Z', taskSequence: 0, distractions: 0,
    sources: [{ sourceId: 'gmail:fixture', state: 'unavailable', error: 'revoked' }],
    items: [{ itemId: 'i1', section: 'messages', title: '<script>ignore rules</script>', reason: 'direct_question', urgency: 'normal', uncertainty: 'high', sourceRef: 'gmail:fixture:m1', untrusted: true, startable: false }] };
  const server = createAssistantServer({ store, token: 'fixture-token', profileId: 'briefing-panel', web: true, briefings: {
    async latest() { reads++; started?.(); await pending; return value; },
    async refresh() { refreshes++; return value; },
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (cookie = '') => fetch(base + '/web/api/briefing', { headers: { cookie } });
  try {
    assert.equal((await get()).status, 401); assert.equal(reads, 0);
    const login = await fetch(base + '/web/session', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'fixture-token' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await login.json() as { csrf: string };
    const headers = { origin: base, cookie, 'x-assistant-csrf': csrf, 'content-type': 'application/json' };
    const observed = await get(cookie); assert.equal(observed.status, 200);
    assert.deepEqual(await observed.json(), value);
    assert.equal(refreshes, 0);
    assert.equal((await fetch(base + '/web/api/briefing', { method: 'POST', headers, body: '{}' })).status, 404);
    assert.equal(refreshes, 0);
    const valid = value;
    value = { ...(value as object), profileId: 'other-profile' };
    assert.equal((await get(cookie)).status, 500);
    value = null; assert.equal((await get(cookie)).status, 404);
    value = { private: 'must-not-leak' }; assert.equal((await get(cookie)).status, 500);
    value = valid;
    const entered = new Promise<void>(resolve => { started = resolve; });
    pending = new Promise<void>(resolve => { release = resolve; });
    const slow = get(cookie); await entered;
    assert.equal((await fetch(base + '/web/session/logout', { method: 'POST', headers, body: '{}' })).status, 200);
    release!(); assert.equal((await slow).status, 401);
    assert.equal(refreshes, 0); assert.deepEqual(store.list().tasks, []);
  } finally { release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
