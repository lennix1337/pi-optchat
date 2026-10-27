import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { registerCatchup } from '../src/catchup-integration.ts';
import type { Entry } from '../src/memory.ts';
import { withTempDir } from './support.ts';

test('a fresh native resource loader discovers the packaged catch-up skill without chat context', async () => withTempDir('catchup-discovery-', async dir => {
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noContextFiles: true, noPromptTemplates: true, additionalSkillPaths: [fileURLToPath(new URL('../skills/optchat-catchup', import.meta.url))] });
  await loader.reload();
  const skill = loader.getSkills().skills.find(skill => skill.name === 'optchat-catchup');
  assert.ok(skill, 'packaged discovery must not rely on this conversation');
  assert.match(skill.description, /previous message|heartbeat wakes/);
}));

test('installed Pi SDK dispatches human/extension input, command and tool to the same frozen receipt without inference', async () => withTempDir('catchup-native-', async dir => {
  let inference = 0;
  const rows: Entry[] = [], notices: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions', models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple() { inference++; throw new Error('catch-up must not request inference'); } });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
    extensionFactories: [pi => { registerCatchup(pi, () => ({ dir, entries: rows, flush: () => {}, attention: () => ({ approvals: 0, uncertain: 0, agents: 0, shells: 0 }) })); }] });
  await loader.reload();
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(dir, join(dir, 'sessions')), tools: [] });
  const errors: string[] = [];
  try {
    await session.bindExtensions({ mode: 'tui', onError: error => errors.push(error.error), uiContext: { ...session.extensionRunner!.getUIContext(), notify: text => notices.push(text), setWidget: () => {} } });
    const runner = session.extensionRunner!;
    await runner.emitInput('start', undefined, 'interactive');
    rows.push({ i: 0, kind: 'work', text: '[OptChat heartbeat] work', size: 1, date: new Date().toISOString() });
    await runner.emitInput('synthetic continuation', undefined, 'extension');
    rows.push({ i: 1, kind: 'talk', text: 'Change reported, no deployment.', size: 1, date: new Date().toISOString() });
    await runner.emitInput('return', undefined, 'interactive');
    const tool = runner.getToolDefinition('catchup_report')!;
    const receipt = await tool.execute('receipt', {}, undefined, undefined, runner.createToolContext('receipt', undefined));
    assert.match(receipt.content[0].type === 'text' ? receipt.content[0].text : '', /1 wakes/);
    runner.setUIContext({ ...runner.getUIContext(), notify: text => notices.push(text) }, 'rpc');
    await runner.getCommand('catchup')!.handler('', runner.createCommandContext());
    assert.match(notices.at(-1)!, /1 wakes/);
    const repeated = await tool.execute('again', {}, undefined, undefined, runner.createToolContext('again', undefined));
    assert.deepEqual(receipt.details, repeated.details);
    assert.equal(inference, 0);
    assert.deepEqual(errors, []);
  } finally { session.dispose(); }
}));
