import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerCli, probeDocker } from '../src/computer/docker.ts';
import { ExecutorDesk } from '../src/ops/executor-desk.ts';
import { TOOL_IMAGE } from '../src/runtime/tool-service.ts';
import { createPrivateDirectory } from '../src/store/private-directory.ts';
import { freePort, launchWeb } from './ops-support.ts';
import { fakeProvider, fixtureAgentDir, panelSession } from './executor-support.ts';

const profileId = 'tools-journey';
test('service with executor tools: a panel task proposes a preview, waits for the operator desk, then shows the isolated snapshot once', { timeout: 150000 }, async () => {
  const probe = await probeDocker(TOOL_IMAGE);
  if (!probe.available || !probe.imagePresent) throw new Error(`docker backend or ${TOOL_IMAGE} unavailable; this suite never pulls`);
  const dir = join(tmpdir(), 'executor-tools-journey-' + randomUUID()); createPrivateDirectory(dir);
  const provider = await fakeProvider({ preview: 'pré-visualização isolada 4242' });
  const endpoint = `http://127.0.0.1:${await freePort()}`, config = join(dir, 'config.json'), token = randomUUID();
  const settings = { version: 1 as const, profileId, databasePath: join(dir, 'tasks.sqlite'), endpoint, token,
    executor: { provider: 'fixture', model: 'draft', agentDir: fixtureAgentDir(dir, provider.url), channels: ['Rascunhos'], tools: true as const } };
  writeFileSync(config, JSON.stringify(settings));
  const owner = `assistant-${createHash('sha256').update(profileId).digest('hex').slice(0, 16)}`;
  let running: ReturnType<typeof launchWeb> | undefined;
  try {
    running = launchWeb(config); await running.ready;
    const api = await panelSession(endpoint, token);
    const created = await api.post('/web/api/tasks', { title: 'Mostrar uma prévia' });
    const desk = new ExecutorDesk(settings);
    try {
      let reviews = desk.reviews();
      for (const deadline = Date.now() + 20000; !reviews.length && Date.now() < deadline; reviews = desk.reviews()) await new Promise(resolve => setTimeout(resolve, 250));
      assert.deepEqual(reviews.map(review => [review.taskId, review.text]), [[created.taskId, 'pré-visualização isolada 4242']]);
      await new Promise(resolve => setTimeout(resolve, 2500));
      assert.equal((await api.task(created.taskId)).status, 'working', 'unreviewed, nothing ran and the task keeps waiting');
      assert.equal(provider.requests.length, 1);
      desk.decide(reviews[0].reviewId, 'approve');
    } finally { desk.close(); }
    await api.until(created.taskId, 'ready_for_review', 60000);
    assert.match((await api.events(created.taskId)).at(-1)!.evidence.reference, /pré-visualização isolada 4242/);
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(provider.requests.length, 1, 'one generation; the approved preview ran once');
    const inspection = await fetch(endpoint + '/web/api/inspection', { headers: { cookie: (await (await fetch(endpoint + '/web/session', { method: 'POST', headers: { origin: endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ token }) })).headers.get('set-cookie')!.split(';')[0]) } });
    assert.deepEqual(((await inspection.json()) as { restored: unknown[] }).restored, []);
  } finally {
    await running?.stop(); await provider.close();
    const left = await dockerCli(['ps', '--all', '--quiet', '--filter', `label=optchat.computer.owner=${owner}`]);
    for (const id of left.stdout.split(/\r?\n/).filter(Boolean)) await dockerCli(['rm', '--force', id]);
    rmSync(dir, { recursive: true, force: true });
  }
});
