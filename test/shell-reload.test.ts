import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile } from '../src/profiles.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction } from './support.ts';

const text = (context: Context) => JSON.stringify(context.messages);

test('a background shell started before /reload keeps running and reports its end to the reloaded session', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-shell-reload-'));
  const name = 'shell-reload'; createProfile(name);
  const contexts: Context[] = [];
  let calls = 0;
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 60000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const compaction = isCompaction(context);
      if (!compaction) { calls++; contexts.push(structuredClone(context)); }
      const start = !compaction && calls === 1;
      const content: AssistantMessage['content'] = compaction ? [{ type: 'text', text: 'tool: shell_start; echo: started.' }]
        : start ? [{ type: 'toolCall', id: 'start-1', name: 'shell_start', arguments: { command: `node -e "setTimeout(() => console.log('late-done'), 2500)"` } }]
        : [{ type: 'text', text: 'OK' }];
      const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: start ? 'toolUse' : 'stop', usage: { ...emptyUsage(), input: 10, totalTokens: 10 } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); stream.end(); });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions')); manager.appendCustomEntry('optchat.profile', { name });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager });
  const bind = () => session.bindExtensions({ mode: 'print', onError: () => {}, uiContext: { ...session.extensionRunner.getUIContext(), notify: () => {} } });
  await bind();
  try {
    await session.prompt('Start the slow job in the background.');
    const started = text(contexts.at(-1)!).match(/Background shell ([0-9a-f-]{36}) started/)?.[1];
    assert.ok(started, 'shell_start returned an id before the reload');
    await session.reload(); // Pi re-runs the extension and emits session_start (reason reload) to the bound session itself.
    const deadline = Date.now() + 20_000;
    while (!contexts.some(context => text(context).includes(`[shell ${started}]`)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const report = contexts.map(text).find(t => t.includes(`[shell ${started}]`));
    assert.ok(report, 'the reloaded session hears about the shell started before the reload');
    assert.match(report, /completed · exit 0/, 'the shell ran to its end instead of being stopped by the reload');
    assert.match(report, /late-done/);
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); rmSync(dir, { recursive: true, force: true });
  }
});
