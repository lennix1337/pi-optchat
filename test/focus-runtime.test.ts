import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

const evidence = 'ARCHIVED-FOCUS-EVIDENCE: scope is disposable KBTeste only; publishing prohibited.';

test('real Pi tools feed focus into the next turn, and reopening the profile clears only focus', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-focus-runtime-'));
  const priorHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const captured: Context[] = [];
  let mainCalls = 0;
  const errors: string[] = [];
  try {
    createProfile('fixture');
    const profile = profilePath('fixture');
    saveConfig(profile, { ...loadConfig(profile), compactor: { provider: 'focus-fixture', model: 'fixture', thinking: 'off' } });
    const memory = new Memory(profile, async () => 'Historical scope; open original.', () => {});
    memory.append('user', evidence + ' Synthetic archival detail.'.repeat(40));
    await memory.settle(AbortSignal.timeout(3000), 'tree');
    await memory.close();
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('focus-fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Focus fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 50000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = isCompaction(context);
        if (!compression) { captured.push(structuredClone(context)); mainCalls++; }
        const tool = !compression && mainCalls === 1;
        const message: AssistantMessage = { role: 'assistant', content: tool
          ? [{ type: 'toolCall', id: 'read-original', name: 'zoom', arguments: { id: 0 } }]
          : [{ type: 'text', text: compression ? 'Fixture summary.' : 'Synthetic completed response.' }],
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: tool ? 'toolUse' : 'stop', usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message }); stream.end(); });
        return stream;
      },
    });
    const open = async () => {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
        noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
      await loader.reload();
      const manager = SessionManager.inMemory(dir); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
      const result = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('focus-fixture', 'fixture'), resourceLoader: loader,
        settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
      await result.bindExtensions({ onError: error => errors.push(error.error) });
      return result;
    };
    const close = async () => { if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); session = undefined; } };
    session = await open();
    await session.prompt('Read the old scope original once.');
    assert.equal(captured.length, 2, 'one native zoom tool roundtrip');
    assert.ok(!JSON.stringify(captured[0]).includes(evidence), 'fixture view itself hides original detail');
    await session.prompt('Resume that subject, without reading again.');
    assert.ok(JSON.stringify(captured.at(-1)).includes(evidence), 'next real provider request resolves original via the focus reference');
    // Focus updates are batched: the first turn request after a tool keeps its original prefix.
    const firstUser = (c: Context) => c.messages.find(m => m.role === 'user')?.content;
    assert.deepEqual(firstUser(captured[0]), firstUser(captured[1]));
    await close();
    session = await open();
    await session.prompt('Fresh process-style reopening; only tree should remain.');
    const reopening = captured.at(-1)!;
    assert.ok(!JSON.stringify(reopening).includes(evidence), 'ephemeral focus must not be persisted into another open session');
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (priorHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = priorHome;
    removeDir(dir);
  }
});
