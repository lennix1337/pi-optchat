import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateDirectory } from '../src/store/private-directory.ts';
import { freePort, launchWeb } from './ops-support.ts';
import { fakeProvider, fixtureAgentDir, panelSession } from './executor-support.ts';

test('without executor.tools the service creates no tool gateway or computer and a model-proposed preview fails the task', { timeout: 60000 }, async () => {
  const dir = join(tmpdir(), 'executor-tools-off-' + randomUUID()); createPrivateDirectory(dir);
  const provider = await fakeProvider({ preview: 'não deve abrir' });
  const endpoint = `http://127.0.0.1:${await freePort()}`, config = join(dir, 'config.json'), token = randomUUID();
  writeFileSync(config, JSON.stringify({ version: 1, profileId: 'tools-off', databasePath: join(dir, 'tasks.sqlite'), endpoint, token,
    executor: { provider: 'fixture', model: 'draft', agentDir: fixtureAgentDir(dir, provider.url), channels: ['Rascunhos'] } }));
  let running: ReturnType<typeof launchWeb> | undefined;
  try {
    running = launchWeb(config); await running.ready;
    const api = await panelSession(endpoint, token);
    const created = await api.post('/web/api/tasks', { title: 'Tentar prévia' });
    await api.until(created.taskId, 'failed', 30000);
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(['tool-gateway.sqlite', 'computer.sqlite'].map(name => existsSync(join(dir, name))), [false, false]);
  } finally { await running?.stop(); await provider.close(); rmSync(dir, { recursive: true, force: true }); }
});
