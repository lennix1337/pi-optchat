import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { artifactFixture, client } from './artifact-support.ts';

function statusWithHost(url: string, host: string, cookie: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host, cookie } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.end();
  });
}
const directives = (policy: string) => new Map(policy.split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

test('untrusted HTML preview is an opaque-origin, script-less document framed only by the panel', async () => artifactFixture(async f => {
  const opened = f.current();
  const record = opened.registry.register({ sourcePath: join(f.paths.sources, 'pagina-hostil.html'), type: 'page', ownerId: 'operator', producerId: 'skill:frontend-design', provenance: 'fixture://hostile' });
  const web = client(opened, await opened.login());
  const { url, response } = await web.preview(record.artifactId, 1);
  assert.equal(response.status, 200);
  const policy = directives(response.headers.get('content-security-policy')!);
  assert.deepEqual(policy.get('sandbox'), [], 'sandbox without allow-scripts, allow-same-origin, forms, popups or top navigation');
  assert.deepEqual(policy.get('default-src'), ["'none'"]);
  assert.equal(policy.has('script-src'), false);
  for (const name of ['img-src', 'font-src', 'media-src']) assert.deepEqual(policy.get(name), ['data:'], name);
  assert.deepEqual(policy.get('style-src'), ["'unsafe-inline'"]);
  assert.deepEqual(policy.get('form-action'), ["'none'"]);
  assert.deepEqual(policy.get('base-uri'), ["'none'"]);
  assert.deepEqual(policy.get('frame-ancestors'), [opened.base]);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('set-cookie'), null);
  // Bytes are preserved for integrity; isolation comes from the policy, not from rewriting content.
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(join(f.paths.sources, 'pagina-hostil.html')));
  // The preview URL is a random capability, not derived from the artifact identity.
  assert.match(url, /^\/web\/preview\/[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(url, new RegExp(`${record.artifactId}|${record.hash.slice(0, 12)}`));
  const again = await web.post(`${web.version(record.artifactId, 1)}/preview`);
  assert.notEqual((await again.json() as { url: string }).url, url);
  const download = await web.get(`${web.version(record.artifactId, 1)}/download`);
  assert.deepEqual(directives(download.headers.get('content-security-policy')!).get('sandbox'), []);
  assert.match(download.headers.get('content-disposition')!, /^attachment;/);
}));

test('the panel may frame only same-origin previews and is itself never framed', async () => artifactFixture(async f => {
  const res = await f.current().fetch('/');
  const policy = directives(res.headers.get('content-security-policy')!);
  assert.deepEqual(policy.get('frame-src'), ["'self'"]);
  assert.deepEqual(policy.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(policy.get('script-src'), ["'self'"]);
  const html = await res.text();
  assert.match(html, /<iframe id="preview-frame"[^>]* sandbox=""/);
  assert.match(html, /<iframe id="preview-frame"[^>]* referrerpolicy="no-referrer"/);
  for (const path of ['/app/artifacts/artifacts.js', '/app/voice/voice.js', '/app/voice/voice-ui.js']) {
    const asset = await f.current().fetch(path);
    assert.equal(asset.status, 200, path);
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
    assert.doesNotMatch(await asset.text(), /innerHTML|DISPOSABLE-ARTIFACT-TEST-TOKEN/, path);
  }
  assert.equal((await f.current().fetch('/app/voice/%2e%2e%2fapp.js')).status, 404);
}));

test('preview and download need the session cookie; tokens are session-bound, expiring and not public', async () => {
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  try {
    await artifactFixture(async f => {
      const opened = f.current();
      const record = opened.registry.register({ sourcePath: join(f.paths.sources, 'pagina-inicial.html'), type: 'page', ownerId: 'operator', producerId: 'p', provenance: 'fixture://page' });
      const session = await opened.login();
      const web = client(opened, session);
      const downloadPath = `${web.version(record.artifactId, 1)}/download`;
      assert.equal((await opened.fetch(downloadPath)).status, 401);
      assert.equal((await opened.fetch(downloadPath, { headers: { authorization: 'Bearer DISPOSABLE-ARTIFACT-TEST-TOKEN' } })).status, 401);
      assert.equal((await opened.fetch('/web/api/artifacts')).status, 401);
      assert.equal(await statusWithHost(`${opened.base}${downloadPath}`, `localhost:${new URL(opened.base).port}`, session.cookie), 403);
      assert.equal((await opened.fetch(`${web.version(record.artifactId, 1)}/preview`, { method: 'POST', headers: { origin: opened.base, cookie: session.cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
      assert.equal((await opened.fetch(`${web.version(record.artifactId, 1)}/preview`, { method: 'POST', headers: { origin: 'https://foreign.test', cookie: session.cookie, 'x-assistant-csrf': session.csrf, 'content-type': 'application/json' }, body: '{}' })).status, 403);
      const { url, response } = await web.preview(record.artifactId, 1);
      assert.equal(response.status, 200);
      assert.equal((await opened.fetch(url)).status, 401, 'a copied preview URL alone opens nothing');
      const other = client(opened, await opened.login());
      assert.equal((await other.get(url)).status, 404, 'another browser session cannot use this capability');
      const fresh = await other.preview(record.artifactId, 1);
      assert.equal(fresh.response.status, 200);
      now += 5 * 60_000 + 1;
      assert.equal((await other.get(fresh.url)).status, 404, 'expired capability');
      assert.equal((await other.get('/web/preview/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status, 404);
      assert.equal((await other.get('/web/preview/short')).status, 404);
      assert.equal((await other.post(`${web.version(record.artifactId, 9)}/preview`)).status, 404, 'no capability for a missing version');
    });
  } finally { Date.now = originalNow; }
});

test('logout revokes previews and downloads in that browser session', async () => artifactFixture(async f => {
  const opened = f.current();
  const record = opened.registry.register({ sourcePath: join(f.paths.sources, 'painel-metricas.html'), type: 'dashboard', ownerId: 'operator', producerId: 'p', provenance: 'fixture://dashboard' });
  const session = await opened.login();
  const web = client(opened, session);
  const { url } = await web.preview(record.artifactId, 1);
  assert.equal((await opened.fetch('/web/session/logout', { method: 'POST', headers: { origin: opened.base, cookie: session.cookie, 'x-assistant-csrf': session.csrf } })).status, 200);
  assert.equal((await web.get(url)).status, 401);
  assert.equal((await web.get(`${web.version(record.artifactId, 1)}/download`)).status, 401);
}));
