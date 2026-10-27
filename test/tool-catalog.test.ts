import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

const previous = 'Read a managed background shell state and bounded output, or list current session shells. Reading never waits for completion. A shell that ends is reported to you automatically, so read it only when you need more of its output.';

test('actual default provider catalog is stable and shell status description is smaller', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-catalog-'));
  const requests: any[] = [];
  let discover: () => any[] = () => { throw new Error('extension not registered'); };
  let activateDiagnostics: () => void = () => { throw new Error('extension not registered'); };
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000, compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } }],
    streamSimple(model, context) {
      requests.push(structuredClone(context));
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'OK' }], api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop', usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message }); stream.end(); return stream;
    } });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat, api => { discover = () => api.getAllTools(); activateDiagnostics = () => { api.setActiveTools([...api.getActiveTools(), 'context_metrics']); }; }] });
  await loader.reload();
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(dir, join(dir, 'sessions')) });
  try {
    await session.bindExtensions({ mode: 'print' });
    await session.prompt('fixture one');
    const discovered = discover();
    assert.ok(discovered.some(tool => tool.name === 'context_metrics' && tool.exposure === 'deferred'));
    await session.prompt('fixture two');
    const catalog = (request: any) => request.messages.flatMap((m: any) => m.role === 'system' ? m.toolsAdded ?? [] : []);
    const first = catalog(requests[0]), second = catalog(requests[1]);
    assert.deepEqual(second, first, 'provider tool ordering and schemas remain stable across discovery');
    assert.deepEqual(requests[1].messages[0], requests[0].messages[0], 'discovery does not mutate the cached system prefix');
    const shell = first.find((tool: any) => tool.name === 'shell_status');
    assert.ok(shell, 'real default provider catalog contains shell_status');
    assert.ok(!first.some((tool: any) => tool.name === 'context_metrics'), 'deferred diagnostics stay out of default catalog');
    const before = JSON.stringify(first).replace(shell.description, previous);
    const after = JSON.stringify(first);
    console.log(`provider catalog JSON chars: before=${before.length} after=${after.length}; UTF-8 bytes: before=${Buffer.byteLength(before)} after=${Buffer.byteLength(after)}`);
    assert.ok(after.length < before.length, 'default provider catalog must shrink');
    assert.match(shell.description, /never waits/);
    assert.match(shell.description, /automatically/);
    activateDiagnostics();
    await session.prompt('fixture with diagnostics enabled');
    assert.deepEqual(requests[2].messages[0], requests[0].messages[0], 'deferred activation preserves the original system/catalog prefix');
    const additions = catalog(requests[2]).filter((tool: any) => tool.name === 'context_metrics');
    assert.equal(additions.length, 1, 'deferred tool is appended once after activation');
  } finally { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); removeDir(dir); }
});
