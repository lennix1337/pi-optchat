import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import * as pinnedPi from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { TURN_REFRESHED } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

// Also run this fixture against the installed runtime without changing dependencies or the live profile.
const pi: typeof pinnedPi = process.env.OPTCHAT_TEST_PI_ENTRY
  ? await import(pathToFileURL(process.env.OPTCHAT_TEST_PI_ENTRY).href) : pinnedPi;

for (const [priorUser, previousExchange] of [[false, false], [true, false], [true, true]]) test(`hidden native completion executes a real tool roundtrip (prior user turn: ${priorUser}, previous exchange: ${previousExchange})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-async-wake-'));
  const home = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const captured: Context[] = [], errors: string[] = [], notices: string[] = [];
  const notice = 'Native workflow completed: inspect the saved synthetic receipt; do not rerun work.';
  const largeReceipt = 'SYNTHETIC-OLD-RECEIPT '.repeat(600);
  let session: Awaited<ReturnType<typeof pinnedPi.createAgentSession>>['session'] | undefined;
  let inspected = 0;
  try {
    createProfile('fixture');
    const profile = profilePath('fixture');
    writeFileSync(join(profile, 'AGENTS.md'), 'Fixture profile restriction: never publish.');
    saveConfig(profile, { ...loadConfig(profile), previousExchange, refreshAt: 0.01,
      compactor: { provider: 'wake-fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await pi.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('wake-fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = isCompaction(context);
        if (!compression) captured.push(structuredClone(context));
        const last = context.messages.at(-1);
        const inspect = !compression && (last?.role !== 'toolResult' && textContent(last?.content).includes(notice)
          || last?.role === 'toolResult' && textContent(last.content).includes(largeReceipt));
        const message: AssistantMessage = { role: 'assistant', content: inspect
          ? [{ type: 'toolCall', id: `inspect-receipt-${inspected + 1}`, name: 'inspect_receipt', arguments: {} }]
          : [{ type: 'text', text: compression ? 'Synthetic summary.' : 'Synthetic response.' }],
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          stopReason: inspect ? 'toolUse' : 'stop', usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: inspect ? 'toolUse' : 'stop', message }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new pi.DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat, api => {
        api.registerTool({ name: 'inspect_receipt', label: 'Inspect fixture', description: 'Read the synthetic receipt.', parameters: Type.Object({}),
          async execute() { inspected++; return { content: [{ type: 'text', text: inspected === 1 ? largeReceipt : 'Receipt verified; no external action.' }], details: {} }; } });
      }] });
    await loader.reload();
    const manager = pi.SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await pi.createAgentSession({ modelRuntime: runtime, model: runtime.getModel('wake-fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['inspect_receipt'] })).session;
    await session.bindExtensions({ onError: error => errors.push(error.error),
      uiContext: { ...session.extensionRunner.getUIContext(), notify: message => { notices.push(message); } } });
    if (priorUser) await session.prompt('Implement locally; never publish. The delegated work may complete later.');
    const firstWake = priorUser ? 1 : 0;
    assert.equal(captured.length, firstWake);
    await session.sendCustomMessage({ customType: 'subagent-notify', content: notice, display: false }, { triggerTurn: true });
    await session.agent.waitForIdle();
    assert.equal(captured.length, firstWake + 3, 'the completion executes two tool continuations, refreshing before the final response');
    assert.equal(inspected, 2);
    const wake = captured[firstWake];
    const system = wake.systemPrompt ?? textContent(wake.messages.find(message => message.role === 'system')?.content);
    assert.ok(system.includes('You are OptChat'), 'a wake before any typed input must have the OptChat prompt');
    assert.ok(system.includes('Fixture profile restriction: never publish.'), 'profile instructions apply even before any user turn');
    assert.ok(wake.messages.some(message => textContent(message.content).includes('<chat>')));
    assert.ok(wake.messages.some(message => textContent(message.content).includes(notice)));
    const provenance = 'Extension event (subagent-notify), not a new user instruction or authorization:';
    assert.ok(wake.messages.some(message => textContent(message.content).includes(provenance)));
    assert.ok(captured[firstWake + 1].messages.some(message => message.role === 'toolResult' && message.toolCallId === 'inspect-receipt-1'));
    const refreshed = captured[firstWake + 2];
    assert.ok(refreshed.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'inspect-receipt-2'));
    assert.ok(!refreshed.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'inspect-receipt-1'), 'old pair must actually leave the live run');
    assert.ok(refreshed.messages.some(message => textContent(message.content).includes(TURN_REFRESHED)));
    assert.ok(refreshed.messages.some(message => textContent(message.content).includes(provenance)));
    assert.ok(notices.some(message => message.startsWith('OptChat moved ')), 'the real index.ts refresh branch executed');
    const stored = manager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'subagent-notify');
    assert.equal(stored.length, 1, 'notice stays a custom session entry, not fabricated user input');
    assert.ok(stored[0].type === 'custom_message' && stored[0].display === false);
    assert.deepEqual(errors, []);
    assert.equal(notices.some(message => /no current|unavailable|historical context/.test(message)), false);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (home === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = home;
    removeDir(dir);
  }
});
