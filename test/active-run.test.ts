import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { retainedRun, needsRunRefresh, assertContextFits } from '../src/run-context.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction } from './support.ts';

const user: AgentMessage = { role: 'user', content: 'Finish this task.', timestamp: 1 };
const call = (id: string): AgentMessage => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'dump', arguments: {} }], api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 2, stopReason: 'toolUse', usage: emptyUsage() });
const echo = (id: string): AgentMessage => ({ role: 'toolResult', toolCallId: id, toolName: 'dump', content: [{ type: 'text', text: 'original result' }], isError: false, timestamp: 3 });

test('refresh retains live user instructions and the last whole tool exchange, never orphaning tool results', () => {
  const steering: AgentMessage = { ...user, content: 'New constraint.', timestamp: 4 };
  const run = [user, call('a'), echo('a'), steering, call('b'), echo('b')];
  assert.deepEqual(retainedRun(run), [user, steering, call('b'), echo('b')]);
  assert.throws(() => retainedRun([user, call('a')]), /incomplete tool exchange/i);
  assert.throws(() => retainedRun([user, call('a'), echo('wrong')]), /incomplete tool exchange/i);
});

test('the recipe-sized active-run cap and model safety budget both trigger refresh; oversized retained context refuses', () => {
  const large: AgentMessage = { ...user, content: 'x'.repeat(128001) };
  assert.equal(needsRunRefresh([large], [large], 272000), true);
  assert.equal(needsRunRefresh([user], [user], 272000), false);
  assert.throws(() => assertContextFits([large], 10000), /context.*too large/i);
});

for (const failing of [false, true]) test(failing ? 'a long run refuses to drop unsummarized results when the compactor fails' : 'a long tool run refreshes through the existing tree, keeps originals and completes; automatic/manual Pi snapshots do not cancel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-roll-'));
  const name = failing ? 'active-run-failing' : 'active-run'; createProfile(name);
  const profile = profilePath(name);
  saveConfig(profile, { ...loadConfig(profile), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
  const contexts: AgentMessage[][] = [], errors: string[] = [], notices: string[] = [];
  let calls = 0, compactions = 0;
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 60000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const compression = isCompaction(context);
      if (compression) compactions++; else { calls++; contexts.push(structuredClone(context.messages) as AgentMessage[]); }
      const content: AssistantMessage['content'] = compression ? [{ type: 'text', text: 'tool/echo: dump produced a large synthetic result; originals remain available through zoom.' }]
        : calls <= 18 ? [{ type: 'toolCall', id: `dump-${calls}`, name: 'dump', arguments: { i: calls } }] : [{ type: 'text', text: 'DONE' }];
      // Force the real Pi threshold path after the long run, independently of OptChat's request-boundary refresh.
      const input = !compression && calls === 19 ? 50000 : Math.ceil(JSON.stringify(context.messages).length / 4);
      const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: compression || calls > 18 ? 'stop' : 'toolUse', usage: { ...emptyUsage(), input, totalTokens: input } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (compression && failing) { message.stopReason = 'error'; message.errorMessage = 'synthetic unavailable'; stream.push({ type: 'error', reason: 'error', error: message }); }
        else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
        stream.end();
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 100 }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
    extensionFactories: [optchat, pi => pi.registerTool({ name: 'dump', label: 'Dump', description: 'Synthetic output.', parameters: Type.Object({ i: Type.Number() }),
      async execute(_id, { i }) { return { content: [{ type: 'text', text: `Result ${i}: ` + 'payload '.repeat(2200) }], details: {} }; } })] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions')); manager.appendCustomEntry('optchat.profile', { name });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['dump'] });
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error.error), uiContext: { ...session.extensionRunner.getUIContext(), notify: text => notices.push(text) } });
  try {
    await session.prompt('Run the complete task using dump 18 times; keep all originals.');
    if (failing) {
      assert.notEqual(session.getLastAssistantText(), 'DONE');
      assert.ok(calls < 19, 'the oversized request is not sent as fallback');
      assert.ok(notices.some(text => /cannot refresh.*summaries are missing/i.test(text)));
      const main = join(profile, 'main');
      const log = readdirSync(main).map(file => readFileSync(join(main, file), 'utf8')).join('\n');
      assert.match(log, /Result 1: payload payload/);
      return;
    }
    assert.equal(session.getLastAssistantText(), 'DONE');
    assert.deepEqual(errors, []);
    assert.ok(manager.getEntries().some(entry => entry.type === 'compaction'), 'automatic Pi compaction stores an OptChat snapshot instead of cancelling');
    const sizes = contexts.map(context => JSON.stringify(context).length);
    assert.ok(sizes.some((size, i) => i > 0 && size < sizes[i - 1] / 2), 'active context actually shrinks between provider calls');
    assert.ok(Math.max(...sizes) < 190000, `requests are bounded: ${Math.max(...sizes)}`);
    for (const context of contexts) {
      const calls = new Set(context.flatMap(m => m.role === 'assistant' ? m.content.filter(b => b.type === 'toolCall').map(b => b.id) : []));
      for (const message of context) if (message.role === 'toolResult') assert.ok(calls.has(message.toolCallId), 'no orphan tool result');
    }
    await session.prompt('Reply DONE, no more tools. ' + 'padding '.repeat(200));
    const before = compactions;
    const snapshot = await session.compact();
    assert.match(snapshot.summary, /^<chat>/);
    assert.ok(snapshot.details && (snapshot.details as { optchat?: boolean }).optchat);
    assert.equal(compactions, before, 'Pi stores the existing view; no second independent summary request');
    assert.ok(!notices.some(text => /cancel|disabled/i.test(text)));
    await session.prompt('Reply DONE, no more tools.');
    assert.equal(session.getLastAssistantText(), 'DONE');
    const main = join(profile, 'main');
    const entries = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    assert.equal(entries.filter(entry => entry.kind === 'tool').length, 18, 'replay was not logged twice');
    assert.equal(entries.filter(entry => entry.kind === 'echo').length, 18);
    assert.ok(entries.some(entry => entry.text.includes('Result 1: payload payload')));
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); rmSync(dir, { recursive: true, force: true });
  }
});
