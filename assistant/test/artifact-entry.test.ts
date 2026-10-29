import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateDirectory } from '../src/store/private-directory.ts';
import { freePort, launchWeb as launch } from './ops-support.ts';

test('production --web startup serves registered artifact preview, review and download after restart', { timeout: 60000 }, async () => {
  const dir = join(tmpdir(), 'artifact-entry-' + randomUUID()); createPrivateDirectory(dir);
  const sources = join(dir, 'producer'); mkdirSync(sources);
  const source = join(sources, 'report.html'); const bytes = Buffer.from('<h1>Artifact startup journey</h1>\n'); writeFileSync(source, bytes);
  const endpoint = `http://127.0.0.1:${await freePort()}`;
  const config = join(dir, 'config.json'); const token = randomUUID();
  writeFileSync(config, JSON.stringify({ version: 1, profileId: 'artifact-owner', databasePath: join(dir, 'tasks.sqlite'), endpoint, token }));
  let running: ReturnType<typeof launch> | undefined;
  try {
    const registered = spawnSync(process.execPath, ['assistant/scripts/artifact.mjs', 'register', '--config', config, '--source-root', sources,
      '--source', source, '--type', 'page', '--owner', 'operator', '--producer', 'skill', '--provenance', 'disposable-startup-test'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(registered.status, 0, registered.stderr + registered.stdout);
    const { artifact } = JSON.parse(registered.stdout);
    for (const restart of [false, true]) {
      running = launch(config); await running.ready;
      const login = await fetch(endpoint + '/web/session', { method: 'POST', headers: { origin: endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]; const { csrf } = await login.json() as { csrf: string };
      const headers = { cookie, origin: endpoint, 'x-assistant-csrf': csrf, 'content-type': 'application/json' };
      const gallery = await fetch(endpoint + '/web/api/artifacts', { headers });
      assert.equal(gallery.status, 200, 'production entry must supply the registry, not only test factories');
      const records = (await gallery.json() as { artifacts: { artifactId: string; review: string }[] }).artifacts;
      assert.equal(records.length, 1); assert.equal(records[0].artifactId, artifact.artifactId);
      const path = `/web/api/artifacts/${artifact.artifactId}/versions/1`;
      if (!restart) {
        const reviewed = await fetch(endpoint + path + '/review', { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) });
        assert.equal(reviewed.status, 200);
      } else assert.equal(records[0].review, 'approved');
      const issued = await fetch(endpoint + path + '/preview', { method: 'POST', headers, body: '{}' }); assert.equal(issued.status, 200);
      const { url } = await issued.json() as { url: string };
      for (const target of [url, path + '/download']) {
        const response = await fetch(endpoint + target, { headers }); assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      }
      await running.stop(); running = undefined;
    }
  } finally { await running?.stop(); rmSync(dir, { recursive: true, force: true }); }
});
