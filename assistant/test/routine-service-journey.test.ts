import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateDirectory } from '../src/store/private-directory.ts';
import { freePort, launchWeb, runScript } from './ops-support.ts';
import { fakeProvider, fixtureAgentDir, panelSession } from './executor-support.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('service routine: paused creates nothing; the operator activates it; its slot becomes one task the executor drafts; pause and restart repeat nothing', { timeout: 150000 }, async () => {
  const dir = join(tmpdir(), 'routine-service-' + randomUUID()); createPrivateDirectory(dir);
  const provider = await fakeProvider({ draftsOnly: true });
  const endpoint = `http://127.0.0.1:${await freePort()}`;
  const config = join(dir, 'config.json'); const token = randomUUID();
  writeFileSync(config, JSON.stringify({ version: 1, profileId: 'routine-owner', databasePath: join(dir, 'tasks.sqlite'), endpoint, token, routines: true,
    executor: { provider: 'fixture', model: 'draft', agentDir: fixtureAgentDir(dir, provider.url), channels: ['Rascunhos'] } }));
  const routine = (...args: string[]) => runScript('routine', [args[0], '--config', config, ...args.slice(1)]);
  // A one-minute interval whose next slot falls 20 s from now; its previous slot is already in the past.
  const firstSlot = Date.now() + 20_000;
  const created = routine('create', '--id', 'resumo', '--title', 'Resumo do dia', '--channel', 'Rascunhos',
    '--schedule', JSON.stringify({ kind: 'interval', minutes: 1, anchor: firstSlot - 60_000 }));
  assert.equal(created.status, 0, created.stderr);
  assert.equal((created.json.routine as { state: string }).state, 'paused');
  let running: ReturnType<typeof launchWeb> | undefined;
  try {
    running = launchWeb(config); await running.ready;
    let api = await panelSession(endpoint, token);
    await sleep(3000);
    assert.deepEqual(await api.tasks(), [], 'a paused routine creates no task');

    const activated = routine('resume', '--id', 'resumo', '--by', 'operador');
    assert.equal(activated.status, 0, activated.stderr);
    assert.equal((activated.json.routine as { nextRunAt: number }).nextRunAt, firstSlot);

    const deadline = firstSlot + 30_000;
    let tasks = await api.tasks();
    while (!tasks.length) { if (Date.now() > deadline) throw new Error('the activated routine never created its task'); await sleep(500); tasks = await api.tasks(); }
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Resumo do dia');
    const [origin] = await api.events(tasks[0].taskId);
    assert.equal(origin.channelId, 'Rascunhos');
    assert.equal(origin.source.actorId, 'routine:resumo');
    await api.until(tasks[0].taskId, 'ready_for_review', 30000);
    assert.match((await api.notes(tasks[0].taskId)).at(-1)!, /não enviado:\nOlá equipe/);
    assert.equal(provider.requests.length, 1);

    const paused = routine('pause', '--id', 'resumo');
    assert.equal((paused.json.routine as { state: string; nextRunAt: number | null }).state, 'paused');
    const history = routine('history', '--id', 'resumo');
    assert.deepEqual((history.json.runs as { status: string }[]).map(run => run.status), ['done']);
    assert.ok((routine('list').json.routines as { id: string }[]).some(r => r.id === 'resumo'));

    await running.stop();
    running = launchWeb(config); await running.ready;
    api = await panelSession(endpoint, token);
    await sleep(3000);
    assert.equal((await api.tasks()).length, 1, 'restart repeats no slot');
    assert.equal(provider.requests.length, 1, 'restart makes no new generation');
  } finally { await running?.stop(); await provider.close(); rmSync(dir, { recursive: true, force: true }); }
});
