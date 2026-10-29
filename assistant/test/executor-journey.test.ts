import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateDirectory } from '../src/store/private-directory.ts';
import { freePort, launchWeb } from './ops-support.ts';
import { fakeProvider, fixtureAgentDir, panelSession as session } from './executor-support.ts';


test('service executor: panel task -> question -> persisted answer -> draft, kept across crash without a second generation', { timeout: 150000 }, async () => {
  const dir = join(tmpdir(), 'executor-journey-' + randomUUID()); createPrivateDirectory(dir);
  const provider = await fakeProvider();
  const agentDir = fixtureAgentDir(dir, provider.url);
  const endpoint = `http://127.0.0.1:${await freePort()}`;
  const config = join(dir, 'config.json'); const token = randomUUID();
  writeFileSync(config, JSON.stringify({ version: 1, profileId: 'executor-owner', databasePath: join(dir, 'tasks.sqlite'), endpoint, token,
    executor: { provider: 'fixture', model: 'draft', agentDir, channels: ['Rascunhos'] } }));
  let running: ReturnType<typeof launchWeb> | undefined;
  try {
    running = launchWeb(config); await running.ready;
    let api = await session(endpoint, token);
    const created = await api.post('/web/api/tasks', { title: 'Escrever aviso da reunião' });
    const waiting = await api.until(created.taskId, 'needs_input', 20000);
    assert.match((await api.notes(created.taskId)).at(-1)!, /Qual é o tom/);
    await api.post(`/web/api/tasks/${created.taskId}/respond`, { revision: waiting.revision, inputRevision: waiting.inputRevision, text: 'Formal e curto' });
    await api.until(created.taskId, 'ready_for_review', 20000);
    assert.equal(provider.requests.length, 2);
    assert.match(provider.requests[1], /Formal e curto/, 'the second generation consumed the persisted answer');
    assert.match((await api.notes(created.taskId)).at(-1)!, /não enviado:\nOlá equipe/);

    const stuck = await api.post('/web/api/tasks', { title: 'travar geração' });
    await api.until(stuck.taskId, 'working', 10000);
    const deadline = Date.now() + 10000;
    while (provider.requests.length < 3) { if (Date.now() > deadline) throw new Error('stuck generation never reached the provider'); await new Promise(r => setTimeout(r, 100)); }
    // SIGTERM on Windows ends the process without a drain: the executor never releases its lease.
    await running.stop();

    running = launchWeb(config); await running.ready;
    api = await session(endpoint, token);
    // The crashed owner's 45 s lease must expire before recovery; the interrupted generation is failed, not resent.
    await api.until(stuck.taskId, 'failed', 70000);
    assert.match((await api.notes(stuck.taskId)).at(-1)!, /não houve repetição automática/);
    assert.equal((await api.task(created.taskId)).status, 'ready_for_review');
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(provider.requests.length, 3, 'restart and recovery made no new provider request');
  } finally { await running?.stop(); await provider.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('service quick answers: the question\'s options answer it once; the other option then expires', { timeout: 60000 }, async () => {
  const dir = join(tmpdir(), 'executor-quick-' + randomUUID()); createPrivateDirectory(dir);
  const provider = await fakeProvider({ quickAnswers: ['Formal', 'Descontra\u00eddo'] });
  const endpoint = `http://127.0.0.1:${await freePort()}`;
  const config = join(dir, 'config.json'); const token = randomUUID();
  writeFileSync(config, JSON.stringify({ version: 1, profileId: 'executor-owner', databasePath: join(dir, 'tasks.sqlite'), endpoint, token,
    executor: { provider: 'fixture', model: 'draft', agentDir: fixtureAgentDir(dir, provider.url), channels: ['Rascunhos'] } }));
  let running: ReturnType<typeof launchWeb> | undefined;
  try {
    running = launchWeb(config); await running.ready;
    const api = await session(endpoint, token);
    const created = await api.post('/web/api/tasks', { title: 'Escrever aviso da reuni\u00e3o' });
    const waiting = await api.until(created.taskId, 'needs_input', 20000);
    assert.deepEqual(await api.prompt(created.taskId), { taskId: created.taskId, revision: waiting.revision, inputRevision: waiting.inputRevision,
      prompt: { question: 'Qual \u00e9 o tom da mensagem?', options: ['Formal', 'Descontra\u00eddo'] } });
    const pick = (text: string) => api.send(`/web/api/tasks/${created.taskId}/respond`, { revision: waiting.revision, inputRevision: waiting.inputRevision, text });
    assert.equal((await pick('Formal')).status, 200);
    assert.equal((await pick('Descontra\u00eddo')).status, 409, 'the other option of the answered question is refused');
    await api.until(created.taskId, 'ready_for_review', 20000);
    assert.equal(provider.requests.length, 2);
    assert.match(provider.requests[1], /\\"response\\":\\"Formal\\"/, 'the generation consumed the picked option, not the expired one');
    assert.equal((await api.prompt(created.taskId)).prompt, null);
  } finally { await running?.stop(); await provider.close(); rmSync(dir, { recursive: true, force: true }); }
});
