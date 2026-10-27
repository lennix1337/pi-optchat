import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

for (const toolName of ['grep', 'mcp__google_analytics__run_report'] as const) test(`offline Pi provider projects ${toolName} and reads exact original`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-native-runtime-'));
  const prior = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(root, 'home');
  const profile = 'native-output'; createProfile(profile);
  saveConfig(profilePath(profile), { ...loadConfig(profilePath(profile)), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
  const report = JSON.stringify({ dimensionHeaders: [{ name: 'country' }], metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }],
    rows: Array.from({ length: 200 }, (_, i) => ({ dimensionValues: [{ value: `country${i}` }], metricValues: [{ value: '10' }] })),
    rowCount: 200, metadata: { currencyCode: 'USD' }, propertyQuota: { tokensPerDay: { remaining: 100 } } });
  const original = toolName === 'grep' ? Array.from({ length: 400 }, (_, i) => `src/file${i}.ts:${i + 1}: match`).join('\n') : report;
  const error = `ERROR: action required\n${'diagnostic evidence\n'.repeat(1800)}RETRY prohibited`;
  let calls = 0, projected = '', retrieved = '', observedError = '', errorFlag = false;
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      let content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'toolUse';
      if (isCompaction(context)) { content = [{ type: 'text', text: 'synthetic summary' }]; stopReason = 'stop'; }
      else {
        const results = context.messages.filter((message): message is Extract<typeof message, { role: 'toolResult' }> => message.role === 'toolResult' && message.toolName === toolName);
        if (calls === 0) content = [{ type: 'toolCall', id: 'success', name: toolName, arguments: { fail: false } }];
        else if (calls === 1) {
          const result = results[0]; assert.equal(result.toolCallId, 'success'); assert.equal(result.isError, false);
          projected = textContent(result.content);
          content = [{ type: 'toolCall', id: 'failure', name: toolName, arguments: { fail: true } }];
        } else if (calls === 2) {
          const result = results[1]; observedError = textContent(result.content); errorFlag = result.isError;
          const ref = /output:([a-f0-9]{64})/.exec(projected)![1];
          content = [{ type: 'toolCall', id: 'readback', name: 'output_read', arguments: { ref, offset: 0, limit: 25000 } }];
        } else {
          const result = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'output_read');
          retrieved = result?.role === 'toolResult' ? textContent(result.content) : '';
          content = [{ type: 'text', text: 'Done.' }]; stopReason = 'stop';
        }
        calls++;
      }
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); }); return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
    extensionFactories: [optchat, pi => pi.registerTool({ name: toolName, label: 'Synthetic result', description: 'Offline fixture.', parameters: Type.Object({ fail: Type.Boolean() }),
      async execute(_id, args) { if (args.fail) throw new Error(error); return { content: [{ type: 'text', text: original }], details: { fixture: true } }; } })] });
  await loader.reload();
  const manager = SessionManager.create(root, join(root, 'sessions'));
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager,
    tools: [toolName, 'output_read'] });
  session.extensionRunner!.setFlagValue('optchat-profile', profile);
  try {
    await session.bindExtensions({ mode: 'print', onError: e => { throw new Error(e.error); } });
    await session.prompt('Inspect the fixture and read its original.');
    assert.equal(calls, 4); assert.match(projected, /output:/); assert.ok(Buffer.byteLength(projected) < Buffer.byteLength(original));
    if (toolName !== 'grep') for (const field of ['dimensionHeaders', 'metricHeaders', 'rowCount', 'metadata', 'propertyQuota']) assert.match(projected, new RegExp(field));
    assert.ok(retrieved.includes(`${original}\n[characters 0-${original.length} of ${original.length}]`), 'readback contains the exact original');
    assert.equal(errorFlag, true); assert.equal(observedError, error);
    const canonical = manager.getEntries().flatMap(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === toolName ? [entry.message] : []);
    assert.equal(canonical.length, 2); assert.equal(textContent(canonical[0].content), original); assert.equal(canonical[0].isError, false);
    assert.equal(textContent(canonical[1].content), error); assert.equal(canonical[1].isError, true);
    console.log(`paired ${toolName}: ${Buffer.byteLength(original)} -> ${Buffer.byteLength(projected)} text bytes`);
  } finally {
    await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    if (prior === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = prior;
    removeDir(root);
  }
});

for (const shape of ['unknown-row', 'multi-text', 'grep-multi-text'] as const) test(`offline Pi preserves rejected ${shape} exactly`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-rejected-runtime-'));
  const prior = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(root, 'home');
  const profile = 'rejected-output'; createProfile(profile);
  saveConfig(profilePath(profile), { ...loadConfig(profilePath(profile)), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
  const toolName = shape === 'grep-multi-text' ? 'grep' : 'mcp__google_analytics__run_report';
  const rows = Array.from({ length: 700 }, (_, i) => ({ dimensionValues: [{ value: `country${i}`, ...(i === 10 ? { control: { next: 'retry' } } : {}) }], metricValues: [{ value: '10' }] }));
  const report = JSON.stringify({ dimensionHeaders: [{ name: 'country' }], metricHeaders: [{ name: 'sessions' }], rowCount: 700, rows });
  const image = { type: 'image' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZxxsAAAAASUVORK5CYII=', mimeType: 'image/png' };
  const original = shape === 'unknown-row' ? [{ type: 'text' as const, text: report }, image] : [{ type: 'text' as const, text: report }, { type: 'text' as const, text: 'SECOND BLOCK' }, image];
  const details = { structuredContent: { identity: 'fixture', page: 2 } };
  let calls = 0; let observed: unknown;
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text', 'image'], contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      let content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'toolUse';
      if (isCompaction(context)) { content = [{ type: 'text', text: 'synthetic summary' }]; stopReason = 'stop'; }
      else if (calls++ === 0) content = [{ type: 'toolCall', id: 'report-call', name: toolName, arguments: {} }];
      else { observed = context.messages.find(message => message.role === 'toolResult' && message.toolName === toolName); content = [{ type: 'text', text: 'Done.' }]; stopReason = 'stop'; }
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); }); return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
    extensionFactories: [optchat, pi => pi.registerTool({ name: toolName, label: 'Synthetic report', description: 'Offline fixture.', parameters: Type.Object({}),
      async execute() { return { content: original, details }; } })] });
  await loader.reload();
  const manager = SessionManager.create(root, join(root, 'sessions'));
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: [toolName] });
  session.extensionRunner!.setFlagValue('optchat-profile', profile);
  try {
    await session.bindExtensions({ mode: 'print', onError: e => { throw new Error(e.error); } });
    await session.prompt('Inspect the fixture.');
    assert.equal(calls, 2);
    const canonical = manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === toolName);
    assert.ok(canonical && canonical.type === 'message' && canonical.message.role === 'toolResult');
    assert.deepEqual(canonical.message.content, original); assert.deepEqual(canonical.message.details, details);
    assert.equal(canonical.message.isError, false); assert.equal(canonical.message.toolCallId, 'report-call');
    assert.ok(observed && typeof observed === 'object');
    const provider = observed as typeof canonical.message;
    assert.deepEqual(provider.content, original); assert.equal(provider.isError, false); assert.equal(provider.toolCallId, 'report-call');
    assert.deepEqual(provider.details, details);
  } finally {
    await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    if (prior === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = prior;
    removeDir(root);
  }
});
