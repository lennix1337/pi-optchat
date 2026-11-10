import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import * as pinnedPi from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { RELOAD_ENTRY } from '../src/self-reload.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

const pi: typeof pinnedPi = process.env.OPTCHAT_TEST_PI_ENTRY
  ? await import(pathToFileURL(process.env.OPTCHAT_TEST_PI_ENTRY).href) : pinnedPi;

for (const mode of ['success', 'lost', 'partial'] as const) test(`a real scheduled wake arbitrates reload (${mode})`, { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-reload-')), previous = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let fire: (() => void) | undefined;
  const originalTimer = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const recoveryTimers = new Map<ReturnType<typeof setTimeout>, { fire: () => void; active: boolean }>();
  let checkedLongContinuation = false;
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 60_000 && !fire) { fire = () => fn(...args); const handle = originalTimer(() => {}, 60_000); handle.unref(); return handle; }
    const handle = originalTimer(fn, delay, ...args);
    if (String(fn).includes('Wake continuation not verified')) recoveryTimers.set(handle, { fire: () => fn(...args), active: true });
    return handle;
  }) as typeof setTimeout);
  t.mock.method(globalThis, 'clearTimeout', ((handle: ReturnType<typeof setTimeout>) => {
    const timer = recoveryTimers.get(handle); if (timer) timer.active = false;
    originalClear(handle);
  }) as typeof clearTimeout);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('external fetch forbidden'); });
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: any[]) {
    const target = args[0];
    const ipc = typeof target === 'string' && !/^\d+$/.test(target)
      || target && typeof target === 'object' && typeof target.path === 'string' && target.port === undefined && target.host === undefined;
    if (!ipc) throw new Error('network socket forbidden');
    return (connect as Function).apply(this, args);
  });
  let session: Awaited<ReturnType<typeof pinnedPi.createAgentSession>>['session'] | undefined;
  let calls = 0, reloads = 0, effects = 0, observedContinuation = false, wakeAt: number | undefined, shutdown = false;
  const events: { type: string; text: string }[] = [], errors: string[] = [];
  let done!: () => void, reloadAttempted!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  const reloadAttempt = new Promise<void>(resolve => { reloadAttempted = resolve; });
  try {
    createProfile('fixture'); const profile = profilePath('fixture');
    saveConfig(profile, { ...loadConfig(profile), heartbeatMinutes: 1, heartbeatAlways: true, heartbeatWakes: 1,
      compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await pi.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { api: 'openai-completions', apiKey: 'synthetic', baseUrl: 'https://invalid.local',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = isCompaction(context);
        const step = compression ? -1 : calls++;
        if (!compression && context.messages.some(m => textContent(m.content).includes('Native Pi reload completed.'))) {
          assert.ok(recoveryTimers.size >= 2, 'both old and fresh runtime armed recovery');
          let fired = 0;
          for (const timer of recoveryTimers.values()) if (timer.active) { fired++; timer.fire(); }
          assert.equal(fired, 0, 'after the original continuation starts, advancing past the deadline must not recover a long-running turn');
          checkedLongContinuation = true;
        }
        const content: AssistantMessage['content'] = step === 1
          ? [{ type: 'toolCall', id: 'effect', name: 'fixture_effect', arguments: {} }]
          : step === 2 ? [{ type: 'toolCall', id: 'reload', name: 'self_reload', arguments: { checkpoint: 'Continue this same synthetic wake without repeating the effect.' } }]
          : [{ type: 'text', text: step === 0 ? 'Initial user response.' : 'Continuing the same work.' }];
        const stopReason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
        const message: AssistantMessage = { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
        const stream = createAssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); }); return stream;
      } });
    const settingsManager = pi.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
    const loader = new pi.DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
      disabledBuiltinExtensions: ['mcp', 'codemode'], extensionFactories: [optchat, api => {
        api.registerTool({ name: 'fixture_effect', label: 'Disposable effect', description: 'Write one synthetic receipt.', parameters: Type.Object({}),
          async execute() { effects++; writeFileSync(join(dir, 'receipt.txt'), String(effects)); return { content: [{ type: 'text', text: 'receipt saved' }], details: {} }; } });
      }] });
    await loader.reload(); const manager = pi.SessionManager.create(dir, join(dir, 'sessions')); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await pi.createAgentSession({ cwd: dir, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), settingsManager, resourceLoader: loader, sessionManager: manager, tools: ['self_reload', 'fixture_effect'] })).session;
    await session.bindExtensions({ mode: 'tui', onError: e => errors.push(e.error), uiContext: { ...session.extensionRunner!.getUIContext(), notify: () => {}, setStatus: () => {} },
      commandContextActions: { reload: async () => {
        reloads++;
        if (mode === 'partial') { await session!.extensionRunner!.emit({ type: 'session_shutdown', reason: 'reload' }); shutdown = true; }
        reloadAttempted();
        if (mode !== 'success') throw new Error(`fixture reload ${mode}`);
        await session!.reload();
      } } as any });
    const reopen = async () => {
      if (!shutdown) await session!.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' });
      session!.dispose(); await loader.reload();
      session = (await pi.createAgentSession({ cwd: dir, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), settingsManager, resourceLoader: loader, sessionManager: manager, tools: ['self_reload', 'fixture_effect'] })).session;
      await session.bindExtensions({ mode: 'tui', onError: e => errors.push(e.error), uiContext: { ...session.extensionRunner!.getUIContext(), notify: () => {}, setStatus: () => {} } });
      shutdown = false;
      const after = manager.getBranch().findLast(e => e.type === 'custom' && e.customType === RELOAD_ENTRY);
      assert.ok(after?.type === 'custom'); assert.equal((after.data as { state: string }).state, 'cancelled');
      const saved = JSON.parse(readFileSync(join(profile, 'heartbeat.json'), 'utf8'));
      assert.equal(saved.wakeLog.length, 1); assert.equal(saved.wakeLog[0].at, wakeAt);
      assert.notEqual(saved.wakeLog[0].outcome, 'running'); assert.equal(saved.wakeLog[0].continuation, 'not-verified');
      if (mode === 'partial') assert.equal(saved.wakeLog[0].outcome, 'unsettled');
      assert.equal(manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'optchat-reload-resume').length, 0);
      assert.equal(reloads, 1); assert.equal(effects, 1); assert.equal(readFileSync(join(dir, 'receipt.txt'), 'utf8'), '1');
      await session.prompt('Second synthetic human input.');
      const inputs = manager.getBranch().flatMap(e => e.type === 'message' && e.message.role === 'user' ? [textContent(e.message.content)] : []);
      assert.ok(inputs.some(text => text.includes('Initialize the synthetic session.')));
      assert.ok(inputs.some(text => text.includes('Second synthetic human input.')));
      assert.equal(reloads, 1, 'reopening and a human input never replay the reload');
      assert.equal(effects, 1); assert.equal(readFileSync(join(dir, 'receipt.txt'), 'utf8'), '1');
    };
    session.subscribe(event => {
      if (event.type === 'message_end') {
        const message = event.message;
        const text = textContent('content' in message ? message.content : undefined);
        if (message.role === 'toolResult' && message.toolCallId === 'reload') {
          const state = JSON.parse(readFileSync(join(profile, 'heartbeat.json'), 'utf8'));
          wakeAt = state.wakeLog.at(-1)?.at;
        }
        if (text.includes('This wake is about to end without delivering a change') || text.includes('The self-reload continuation was not observed within its deadline') || message.role === 'custom' && message.customType === 'optchat-reload-resume') {
          events.push({ type: message.role === 'custom' ? message.customType : message.role, text });
          observedContinuation = true;
        }
      }
      if (event.type === 'agent_settled' && observedContinuation) done();
    });
    await session.prompt('Initialize the synthetic session.');
    assert.ok(fire, 'heartbeat must have been armed'); fire();
    if (mode !== 'success') await reloadAttempt;
    if (mode === 'partial') {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(shutdown, true, 'failure happens after the old runtime shuts down');
      const before = manager.getBranch().findLast(e => e.type === 'custom' && e.customType === RELOAD_ENTRY);
      assert.ok(before?.type === 'custom'); assert.equal((before.data as { state: string }).state, 'reloading');
      await reopen();
      return;
    }
    if (mode === 'lost') {
      const active = [...recoveryTimers.values()].filter(timer => timer.active);
      assert.equal(active.length, 1, 'one bounded recovery is armed');
      active[0].active = false; active[0].fire();
    }
    await finished;
    const requested = manager.getBranch().find(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 'reload');
    assert.ok(requested && requested.type === 'message' && requested.message.role === 'toolResult' && !requested.message.isError, 'self_reload must actually accept the request');
    const ticket = manager.getBranch().findLast(e => e.type === 'custom' && e.customType === RELOAD_ENTRY);
    assert.ok(ticket?.type === 'custom', 'ticket must be recorded in the session');
    if (mode === 'lost') assert.equal((ticket.data as { state: string }).state, 'reloading', 'after a possibly partial reload the old runtime must not rewrite the ticket');
    assert.equal(events.some(e => e.text.includes('This wake is about to end without delivering a change')), false, 'an accepted reload must own the next continuation, not an empty-wake retry');
    assert.equal(reloads, 1, 'neither recovery nor reload is replayed');
    assert.equal(checkedLongContinuation, mode === 'success');
    assert.equal(manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'optchat-reload-resume').length, mode === 'success' ? 1 : 0);
    assert.deepEqual(errors, []);
    const saved = JSON.parse(readFileSync(join(profile, 'heartbeat.json'), 'utf8'));
    assert.equal(saved.wakeLog.length, 1);
    assert.equal(saved.wakeLog[0].at, wakeAt, 'the continuation belongs to the original persisted wake');
    assert.equal(saved.wakeLog[0].continuation, mode === 'success' ? 'started' : 'not-verified');
    if (mode === 'lost') { await session.agent.waitForIdle(); await reopen(); }
  } finally {
    if (session) { await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (previous === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = previous;
    removeDir(dir);
  }
});
