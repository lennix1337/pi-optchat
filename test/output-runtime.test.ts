import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import optchat from '../src/index.ts';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

test('real Pi runtime sends preview, searches original, preserves canonical evidence and records numeric metrics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-output-runtime-'));
  const prior = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(root, 'home');
  const profile = 'output-runtime'; createProfile(profile);
  saveConfig(profilePath(profile), { ...loadConfig(profilePath(profile)), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
  const log = `${'build module complete\n'.repeat(1000)}NEEDLE_middle_only\n${'test progress\n'.repeat(1000)}error CS0246 MissingType\nTests: 1 failed, 10 passed\n`;
  let calls = 0, ref = '', projected = '', retrieved = '', metrics = '';
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      let content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop';
      if (isCompaction(context)) content = [{ type: 'text', text: 'echo: synthetic log retained; original recoverable.' }];
      else {
        const messages = context.messages;
        const tool = (name: string) => messages.findLast(message => message.role === 'toolResult' && message.toolName === name);
        if (calls === 0) { content = [{ type: 'toolCall', id: 'run', name: 'bash', arguments: { command: 'synthetic-log' } }]; stopReason = 'toolUse'; }
        else if (calls === 1) {
          const last = tool('bash'); projected = last?.role === 'toolResult' ? textContent(last.content) : '';
          ref = /output:([a-f0-9]{64})/.exec(projected)?.[1] ?? '';
          content = [{ type: 'toolCall', id: 'read-original', name: 'output_read', arguments: { ref, findText: 'NEEDLE_middle_only', limit: 500 } }]; stopReason = 'toolUse';
        } else if (calls === 2) {
          const last = tool('output_read'); retrieved = last?.role === 'toolResult' ? textContent(last.content) : '';
          content = [{ type: 'toolCall', id: 'metrics', name: 'context_metrics', arguments: {} }]; stopReason = 'toolUse';
        } else {
          const last = tool('context_metrics'); metrics = last?.role === 'toolResult' ? textContent(last.content) : '';
          content = [{ type: 'text', text: 'Original inspected.' }];
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
    extensionFactories: [optchat, pi => pi.registerTool({ name: 'bash', label: 'Synthetic log', description: 'Return synthetic log without executing commands.', parameters: Type.Object({ command: Type.String() }),
      async execute() { return { content: [{ type: 'text', text: log }], details: {} }; } })] });
  await loader.reload();
  const manager = SessionManager.create(root, join(root, 'sessions'));
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager,
    tools: ['bash', 'output_read', 'context_metrics'] });
  session.extensionRunner!.setFlagValue('optchat-profile', profile);
  try {
    await session.bindExtensions({ mode: 'print', onError: error => { throw new Error(error.error); } });
    await session.prompt('Inspect the synthetic build log and retrieve the omitted needle.');
    assert.equal(calls, 4); assert.match(projected, /Lossy preview/); assert.match(projected, /CS0246/);
    assert.ok(projected.length < log.length / 4); assert.ok(!projected.includes('NEEDLE_middle_only'));
    assert.match(retrieved, /NEEDLE_middle_only/);
    const canonical = manager.getEntries().flatMap(entry => entry.type === 'message' ? [entry.message] : []).find(message => message.role === 'toolResult' && message.toolName === 'bash');
    assert.equal(canonical?.role === 'toolResult' && textContent(canonical.content), log);
    const report = JSON.parse(metrics); assert.ok(report.request.estimatedTokens > 0); assert.equal(report.output.reads, 1);
    assert.ok(report.stages.projection.count > 0); assert.ok(report.stages.tool.count > 0);
    const journal = JSON.parse(readFileSync(join(profilePath(profile), 'operations.json'), 'utf8'));
    assert.deepEqual(journal.operations.map((operation: { tool: string }) => operation.tool), ['bash']);
    assert.equal(journal.operations[0].error, false);

    // The same provider-only pipeline also runs inside real SDK child sessions.
    calls = 0; projected = ''; retrieved = '';
    const memory = new Memory(join(root, 'child-memory'), async () => 'summary', () => {});
    const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => 'Preserve this exact child instruction.',
      async () => {}, () => {}, profilePath(profile), { createSession: options => createAgentSession({ ...options, modelRuntime: runtime,
        customTools: [...options?.customTools ?? [], { name: 'bash', label: 'Synthetic log', description: 'Return fixture.', parameters: Type.Object({ command: Type.String() }),
          async execute() { return { content: [{ type: 'text', text: log }], details: {} }; } }], tools: ['bash', 'output_read', 'context_metrics', 'zoom', 'date'] }) });
    try {
      const [id] = await children.spawn([{ task: 'Inspect the synthetic log.' }], root);
      await children.live(id)!.completion;
      assert.equal(calls, 4); assert.match(projected, /Lossy preview/); assert.match(retrieved, /NEEDLE_middle_only/);
      assert.equal(children.history.records.get(id)!.state, 'completed');
      assert.equal(children.history.records.get(id)!.model, 'fixture/fixture');
      assert.equal(children.history.records.get(id)!.thinking, 'off');
      const original = children.messages(id).find(message => message.role === 'toolResult' && message.toolName === 'bash');
      assert.equal(original?.role === 'toolResult' && textContent(original.content), log);
    } finally { await children.close(); await memory.close(); }
  } finally {
    await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    if (prior === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = prior;
    removeDir(root);
  }
});
