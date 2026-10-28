import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactRegistry } from '../src/artifacts/registry.ts';
import { sha256 } from '../src/hash.ts';
import { artifactFixture, client, profileId, samples } from './artifact-support.ts';

const register = (registry: ArtifactRegistry, sources: string, file: string, type: (typeof samples)[number]['type'], extra: { artifactId?: string } = {}) =>
  registry.register({ sourcePath: join(sources, file), type, ownerId: 'operator', producerId: 'skill:frontend-design', provenance: 'optchat://task/fixture/run/1', ...extra });

test('each supported sample registers, lists by type, opens and downloads byte-exact through the web client', async () => artifactFixture(async f => {
  const { registry } = f.current();
  for (const sample of samples) {
    const bytes = readFileSync(join(f.paths.sources, sample.file));
    // Samples must be self-contained: no external fetchable URL, font or stylesheet import.
    assert.doesNotMatch(bytes.toString('utf8').replaceAll('xmlns="http://www.w3.org/2000/svg"', ''), /https?:\/\/|@import|@font-face/, sample.file);
    const record = registry.register({ sourcePath: join(f.paths.sources, sample.file), type: sample.type, ownerId: 'operator', producerId: sample.producerId, provenance: `optchat://task/${sample.type}/run/1` });
    assert.deepEqual([record.profileId, record.type, record.artifactVersion, record.hash, record.review, record.fileName], [profileId, sample.type, 1, sha256(bytes), 'not_reviewed', sample.file]);
    assert.equal(record.location, `${record.artifactId}/v1/${sample.file}`);
  }
  const web = client(f.current(), await f.current().login());
  const all = await (await web.get('/web/api/artifacts')).json() as { artifacts: { artifactId: string; type: string; fileName: string }[]; more: boolean };
  assert.equal(all.artifacts.length, samples.length); assert.equal(all.more, false);
  for (const sample of samples) {
    const filtered = await (await web.get(`/web/api/artifacts?type=${sample.type}`)).json() as typeof all;
    assert.deepEqual(filtered.artifacts.map(a => a.fileName), [sample.file]);
    const id = filtered.artifacts[0].artifactId;
    const original = readFileSync(join(f.paths.sources, sample.file));
    const { response } = await web.preview(id, 1);
    assert.equal(response.status, 200, sample.file);
    assert.equal(response.headers.get('content-type'), sample.previewType);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    const download = await web.get(`${web.version(id, 1)}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), sample.downloadType);
    assert.equal(download.headers.get('content-disposition'), `attachment; filename="${sample.file}"; filename*=UTF-8''${sample.file}`);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
  }
  assert.equal((await web.get('/web/api/artifacts?type=presentation')).status, 400);
  assert.equal((await web.get('/web/api/artifacts?type=constructor')).status, 400);
}));

test('versions, review and reopen after restart keep the same hashes, review and downloadable bytes', async () => artifactFixture(async f => {
  const first = register(f.current().registry, f.paths.sources, 'pagina-inicial.html', 'page');
  writeFileSync(join(f.paths.sources, 'pagina-inicial.html'), '<!doctype html><title>v2</title><p>Versão 2</p>');
  const second = register(f.current().registry, f.paths.sources, 'pagina-inicial.html', 'page', { artifactId: first.artifactId });
  assert.equal(second.artifactVersion, 2); assert.notEqual(second.hash, first.hash);
  assert.throws(() => register(f.current().registry, f.paths.sources, 'pagina-inicial.html', 'page', { artifactId: first.artifactId }), /artifact_no_change/);
  assert.throws(() => register(f.current().registry, f.paths.sources, 'apresentacao.html', 'slides', { artifactId: first.artifactId }), /artifact_identity_mismatch/);
  let web = client(f.current(), await f.current().login());
  const review = await web.post(`${web.version(first.artifactId, 1)}/review`, { decision: 'approved' });
  assert.equal(review.status, 200);
  assert.deepEqual(await review.json().then((r: any) => [r.review, r.reviewedBy]), ['approved', 'web-operator']);
  assert.equal((await web.post(`${web.version(first.artifactId, 1)}/review`, { decision: 'rejected' })).status, 409);
  assert.equal((await web.post(`${web.version(first.artifactId, 2)}/review`, { decision: 'maybe' })).status, 400);

  const opened = await f.restart();
  web = client(opened, await opened.login());
  const listed = await (await web.get('/web/api/artifacts?type=page')).json() as { artifacts: { artifactVersion: number; hash: string }[] };
  assert.deepEqual(listed.artifacts.map(a => [a.artifactVersion, a.hash]), [[2, second.hash]]);
  const versions = await (await web.get(`/web/api/artifacts/${first.artifactId}`)).json() as { versions: { artifactVersion: number; review: string }[] };
  assert.deepEqual(versions.versions.map(v => [v.artifactVersion, v.review]), [[1, 'approved'], [2, 'not_reviewed']]);
  const v1 = await web.get(`${web.version(first.artifactId, 1)}/download`);
  assert.equal(sha256(Buffer.from(await v1.arrayBuffer())), first.hash);
  assert.equal((await web.get(`${web.version(first.artifactId, 3)}/download`)).status, 404);
}));

test('a review whose session is revoked while its body is in flight changes nothing', async () => artifactFixture(async f => {
  const opened = f.current();
  const record = register(opened.registry, f.paths.sources, 'pagina-inicial.html', 'page');
  const session = await opened.login();
  const web = client(opened, session);
  const body = JSON.stringify({ decision: 'approved' });
  const received = new Promise<void>(resolve => opened.server.once('request', req => req.once('data', () => resolve())));
  const status = new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${opened.base}${web.version(record.artifactId, 1)}/review`, { method: 'POST', headers: { origin: opened.base, cookie: session.cookie, 'x-assistant-csrf': session.csrf, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject);
    req.write(body.slice(0, 1));
    void received.then(async () => {
      assert.equal((await opened.fetch('/web/session/logout', { method: 'POST', headers: { origin: opened.base, cookie: session.cookie, 'x-assistant-csrf': session.csrf } })).status, 200);
      req.end(body.slice(1));
    }, reject);
  });
  assert.equal(await status, 401);
  assert.equal(opened.registry.get(record.artifactId, 1)?.review, 'not_reviewed');
}));

test('registration refuses unsupported formats, outside sources, missing files and invalid identity', async () => artifactFixture(async f => {
  const { registry } = f.current();
  for (const file of ['report.pdf', 'deck.pptx', 'memo.docx']) {
    writeFileSync(join(f.paths.sources, file), 'binary placeholder');
    assert.throws(() => register(registry, f.paths.sources, file, 'document'), /artifact_format_unsupported/, file);
  }
  assert.throws(() => register(registry, f.paths.sources, 'tokens.json', 'page'), /artifact_format_unsupported/);
  assert.throws(() => registry.register({ sourcePath: join(f.paths.sources, 'tokens.json'), type: '__proto__' as never, ownerId: 'o', producerId: 'p', provenance: 'x' }), /artifact_type_unsupported/);
  mkdirSync(join(f.paths.dir, 'elsewhere'));
  copyFileSync(join(f.paths.sources, 'pagina-inicial.html'), join(f.paths.dir, 'elsewhere', 'pagina-inicial.html'));
  assert.throws(() => registry.register({ sourcePath: join(f.paths.dir, 'elsewhere', 'pagina-inicial.html'), type: 'page', ownerId: 'o', producerId: 'p', provenance: 'x' }), /artifact_source_outside_roots/);
  assert.throws(() => registry.register({ sourcePath: join(f.paths.sources, '..', 'elsewhere', 'pagina-inicial.html'), type: 'page', ownerId: 'o', producerId: 'p', provenance: 'x' }), /artifact_source_outside_roots/);
  assert.throws(() => register(registry, f.paths.sources, 'absent.html', 'page'), /artifact_source_missing/);
  assert.throws(() => registry.register({ sourcePath: join(f.paths.sources, 'pagina-inicial.html'), type: 'page', ownerId: ' ', producerId: 'p', provenance: 'x' }), /artifact_invalid/);
  assert.throws(() => register(registry, f.paths.sources, 'pagina-inicial.html', 'page', { artifactId: 'unknown' }), /artifact_not_found/);
  assert.deepEqual(registry.list().artifacts, []);
}));

test('unicode file names download with an RFC 6266 fallback and other profiles see nothing', async () => artifactFixture(async f => {
  copyFileSync(join(f.paths.sources, 'apresentacao.html'), join(f.paths.sources, 'apresentação final.html'));
  const record = register(f.current().registry, f.paths.sources, 'apresentação final.html', 'slides');
  const web = client(f.current(), await f.current().login());
  const download = await web.get(`${web.version(record.artifactId, 1)}/download`);
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="apresenta__o final.html"; filename*=UTF-8''apresenta%C3%A7%C3%A3o%20final.html`);
  const foreign = new ArtifactRegistry({ databasePath: f.paths.database, profileId: 'other-profile', root: f.paths.root, sourceRoots: [f.paths.sources] });
  try {
    assert.deepEqual(foreign.list().artifacts, []);
    assert.equal(foreign.get(record.artifactId, 1), null);
    assert.throws(() => foreign.read(record.artifactId, 1), /artifact_not_found/);
  } finally { foreign.close(); }
}));

test('a changed managed file is refused instead of served', async () => artifactFixture(async f => {
  const record = register(f.current().registry, f.paths.sources, 'pagina-inicial.html', 'page');
  writeFileSync(join(f.paths.root, record.location), '<p>tampered</p>');
  assert.throws(() => f.current().registry.read(record.artifactId, 1), /artifact_changed/);
  const web = client(f.current(), await f.current().login());
  const res = await web.get(`${web.version(record.artifactId, 1)}/download`);
  assert.equal(res.status, 409); assert.doesNotMatch(await res.text(), /tampered/);
}));

test('a stored location that escapes the managed root is refused even when the bytes match', async () => artifactFixture(async f => {
  const record = register(f.current().registry, f.paths.sources, 'pagina-inicial.html', 'page');
  // Same bytes outside the root: only the location guard, not the hash, can refuse this read.
  copyFileSync(join(f.paths.sources, 'pagina-inicial.html'), join(f.paths.dir, 'outside.html'));
  const db = new DatabaseSync(f.paths.database);
  try {
    for (const location of ['../outside.html', join(f.paths.dir, 'outside.html')]) {
      const row = db.prepare('SELECT artifact FROM artifacts WHERE artifact_id = ?').get(record.artifactId)!;
      db.prepare('UPDATE artifacts SET artifact = ? WHERE artifact_id = ?').run(JSON.stringify({ ...JSON.parse(String(row.artifact)), location }), record.artifactId);
      assert.throws(() => f.current().registry.read(record.artifactId, 1), /artifact_location_invalid/, location);
    }
  } finally { db.close(); }
  const web = client(f.current(), await f.current().login());
  const res = await web.get(`${web.version(record.artifactId, 1)}/download`);
  assert.equal(res.status, 409);
  for (const path of ['/web/api/artifacts/..%2F..%2Fpackage.json/versions/1/download', '/web/api/artifacts/x/versions/..%2F1/download', '/web/api/artifacts/x/versions/0/download']) {
    assert.ok([400, 404].includes((await web.get(path)).status), path);
  }
}));
