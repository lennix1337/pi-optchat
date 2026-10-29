import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openArtifactService } from '../src/artifacts/service.ts';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer } from '../src/http/server.ts';
import { createPrivateDirectory } from '../src/store/private-directory.ts';

test('source root junction resolving to filesystem root is refused before registry creation', () => {
  const dir = join(tmpdir(), `artifact-root-${randomUUID()}`);
  createPrivateDirectory(dir);
  try {
    const link = join(dir, 'root-link');
    symlinkSync(parse(dir).root, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => {
      const registry = openArtifactService({ databasePath: join(dir, 'tasks.sqlite'), profileId: 'owner', sourceRoots: [link] });
      registry.close();
    }, /invalid_options/);
    assert.equal(existsSync(join(dir, 'artifacts')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('trusted CLI registration survives HTTP gallery and registry reopen, isolated by profile', async () => {
  const dir = join(tmpdir(), `artifact-service-${randomUUID()}`);
  createPrivateDirectory(dir);
  const sources = join(dir, 'sources'); mkdirSync(sources);
  const source = join(sources, 'page.html'); const bytes = Buffer.from('<p>exact bytes</p>\n'); writeFileSync(source, bytes);
  const config = join(dir, 'config.json'); const databasePath = join(dir, 'tasks.sqlite');
  const token = 'DISPOSABLE-TEST-TOKEN';
  writeFileSync(config, JSON.stringify({ version: 1, profileId: 'owner', databasePath, endpoint: 'http://127.0.0.1:12345', token }), { mode: 0o600 });
  const invoke = (...args: string[]) => spawnSync(process.execPath, ['assistant/scripts/artifact.mjs', ...args], { encoding: 'utf8' });
  let registry: ReturnType<typeof openArtifactService> | undefined;
  let store: TaskStore | undefined;
  let server: ReturnType<typeof createAssistantServer> | undefined;
  try {
    const help = invoke('--help'); assert.equal(help.status, 0); assert.match(help.stdout, /register/);
    const args = ['--config', config, '--source-root', sources];
    const result = invoke('register', ...args, '--source', source, '--type', 'page', '--owner', 'operator', '--producer', 'skill', '--provenance', 'fixture');
    assert.equal(result.status, 0, result.stderr + result.stdout); assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
    const record = JSON.parse(result.stdout).artifact;
    const listed = invoke('list', ...args); assert.equal(listed.status, 0); assert.equal(JSON.parse(listed.stdout).artifacts[0].artifactId, record.artifactId);
    assert.throws(() => openArtifactService({ databasePath, profileId: 'owner', sourceRoots: [parse(dir).root] }), /invalid_options/);
    registry = openArtifactService({ databasePath, profileId: 'owner', sourceRoots: [sources] });
    const outside = join(dirname(sources), 'outside.html'); writeFileSync(outside, bytes);
    assert.throws(() => registry!.register({ sourcePath: outside, type: 'page', ownerId: 'o', producerId: 'p', provenance: 'x' }), /artifact_source_outside_roots/);
    store = new TaskStore(':memory:', 'owner'); server = createAssistantServer({ store, token, profileId: 'owner', web: true, artifacts: registry });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal((await fetch(base + '/web/api/artifacts')).status, 401);
    const login = await fetch(base + '/web/session', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]; const { csrf } = await login.json() as { csrf: string };
    const gallery = await fetch(base + '/web/api/artifacts', { headers: { cookie } });
    assert.equal((await gallery.json() as { artifacts: { artifactId: string }[] }).artifacts[0].artifactId, record.artifactId);
    const path = `/web/api/artifacts/${record.artifactId}/versions/1`;
    const issued = await fetch(base + path + '/preview', { method: 'POST', headers: { origin: base, cookie, 'x-assistant-csrf': csrf, 'content-type': 'application/json' }, body: '{}' });
    const { url } = await issued.json() as { url: string };
    for (const target of [url, path + '/download']) assert.deepEqual(Buffer.from(await (await fetch(base + target, { headers: { cookie } })).arrayBuffer()), bytes);
    server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
    registry.close(); registry = openArtifactService({ databasePath, profileId: 'owner', sourceRoots: [sources] });
    assert.deepEqual(registry.read(record.artifactId, 1).bytes, bytes); registry.close();
    registry = openArtifactService({ databasePath, profileId: 'foreign', sourceRoots: [sources] });
    assert.throws(() => registry!.read(record.artifactId, 1), /artifact_not_found/);
    assert.throws(() => createAssistantServer({ store: store!, token, profileId: 'owner', web: true, artifacts: registry! }), /Invalid server binding/);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    registry?.close(); store?.close(); rmSync(dir, { recursive: true, force: true });
  }
});
