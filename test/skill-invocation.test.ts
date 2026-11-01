import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { PROMPT } from '../src/recipe-prompt.ts';
import { skillInvocationNote } from '../src/skill-invocation.ts';
import { isCompaction, removeDir } from './support.ts';
import { emptyUsage } from '../src/usage.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
const model = { provider: 'fixture', model: 'fixture', thinking: 'off' } as const;
const block = (name: string) => `<skill name="${name}" location="C:\\skills\\${name}\\SKILL.md">\nReferences are relative to C:\\skills\\${name}.\n\nThe user has asked for a **retrospective**.\n</skill>`;

test('only a skill block gets the invocation note; the operator\'s own words do not', () => {
  assert.match(skillInvocationNote(block('retro')) ?? '', /invoked the skill "retro".*not a compaction/);
  assert.equal(skillInvocationNote(`${block('retro')}\n\nfocus on the wakes`), undefined);
  assert.equal(skillInvocationNote('Compaction: compress message 6'), undefined);
  assert.equal(skillInvocationNote('hello'), undefined);
});

test('the prompt says only a task starting "Compaction:" is a compaction', () => {
  assert.match(PROMPT, /A compaction's task always starts with "Compaction:"; any other call is a turn/);
});

test('a turn that is only a skill block reaches the model with the note after it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-skill-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const turns: Context[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(m, context) {
      if (!isCompaction(context)) turns.push(context);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: isCompaction(context) ? 'summary' : 'ok' }], api: m.api, provider: m.provider, model: m.id,
        timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), compactor: model });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
    await session.bindExtensions({ uiContext: session.extensionRunner.getUIContext(), mode: 'tui' });
    const last = () => JSON.stringify(turns.at(-1)?.messages.slice(-2));
    await session.prompt(block('retro'));
    assert.match(last(), /invoked the skill \\"retro\\"/, 'the bare skill turn says it is an order');
    await session.prompt(`${block('retro')}\n\nonly the wakes`);
    assert.doesNotMatch(last(), /invoked the skill/, 'the operator\'s own words need no note');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});
