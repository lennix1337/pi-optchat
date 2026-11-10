import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import * as pinnedPi from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

const pi: typeof pinnedPi = process.env.OPTCHAT_TEST_PI_ENTRY
  ? await import(pathToFileURL(process.env.OPTCHAT_TEST_PI_ENTRY).href) : pinnedPi;

// Each run settle checkpoints the profile with real git processes (4-5 per settle, ~25 for the human-input case, which settles once more than the others). On a slow Windows runner a spawn costs up to ~0.6 s, so the case legitimately needs 15+ s; the former 15 s budget timed out there. A real hang still fails, at 60 s.
for (const criterion of ['second spawn', 'Slack final', 'Home idle', 'empty retry', 'human input', 'failed child', 'lost report'] as const) test(`owned wake worker: no premature ${criterion}`, { timeout: 60_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-workers-')), previous = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let fire: (() => void) | undefined, expireWorker: (() => void) | undefined;
  let now = Date.now();
  if (criterion === 'lost report') t.mock.method(Date, 'now', () => now);
  const releases: (() => void)[] = [];
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 60_000 && !fire) { fire = () => fn(...args); const h = timer(() => {}, 60_000); h.unref(); return h; }
    if (criterion === 'lost report' && delay === 30 * 60_000) { expireWorker = () => fn(...args); const h = timer(() => {}, delay); h.unref(); return h; }
    return timer(fn, delay, ...args);
  }) as typeof setTimeout);
  const requests: { path: string; body?: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== 'http://127.0.0.1:38123') throw new Error('external fetch forbidden');
    requests.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(url.pathname === '/v1/slack/inbox' ? { messages: [] } : { parts: 1, ts: '1.1', channel: 'D1' });
  });
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: any[]) {
    const target = args[0];
    if (!(typeof target === 'string' && !/^\d+$/.test(target) || target && typeof target === 'object' && typeof target.path === 'string' && target.port === undefined && target.host === undefined)) throw new Error('network socket forbidden');
    return (connect as Function).apply(this, args);
  });
  let session: Awaited<ReturnType<typeof pinnedPi.createAgentSession>>['session'] | undefined;
  let mainCalls = 0, workerStarted = false, released = false, human = false;
  const errors: string[] = [], observed: string[] = [];
  let settled!: () => void;
  const wakeSettled = new Promise<void>(resolve => { settled = resolve; });
  let finishWake!: () => void;
  const wakeFinished = new Promise<void>(resolve => { finishWake = resolve; });
  try {
    createProfile('fixture'); const profile = profilePath('fixture');
    writeFileSync(join(profile, 'assistant.json'), JSON.stringify({ version: 1, profileId: 'fixture', endpoint: 'http://127.0.0.1:38123', token: 'synthetic' }));
    const choice = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
    saveConfig(profile, { ...loadConfig(profile), heartbeatMinutes: 1, heartbeatAlways: true, heartbeatWakes: 1, compactor: choice, subagent: { ...choice, model: 'child' } });
    const runtime = await pi.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { api: 'openai-completions', apiKey: 'synthetic', baseUrl: 'https://invalid.local',
      models: ['fixture', 'child'].map(id => ({ id, name: id, reasoning: false, input: ['text'] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 })),
      streamSimple(model, context) {
        const worker = model.id === 'child';
        const compression = isCompaction(context);
        const step = worker || compression ? -1 : mainCalls++;
        const content: AssistantMessage['content'] = step === 1 || step === 3 && !released && !human
          ? [{ type: 'toolCall', id: step === 1 ? 'spawn-one' : 'spawn-two', name: 'spawn', arguments: { tasks: [{ task: 'SYNTHETIC CHILD TASK' }] } }]
          : [{ type: 'text', text: worker ? 'Child finished.' : step === 0 ? 'Initialized.' : released ? 'Worker report processed.' : 'Worker is running.' }];
        const stopReason = worker && criterion === 'failed child' ? 'error' : content[0].type === 'toolCall' ? 'toolUse' : 'stop';
        const message: AssistantMessage = { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        const finish = () => { if (stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message }); else stream.push({ type: 'done', reason: stopReason, message }); stream.end(); };
        if (worker && !compression) { workerStarted = true; releases.push(finish); } else queueMicrotask(finish);
        return stream;
      } });
    const settingsManager = pi.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
    const loader = new pi.DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
      disabledBuiltinExtensions: ['mcp', 'codemode'], extensionFactories: [optchat] });
    await loader.reload(); const manager = pi.SessionManager.create(dir, join(dir, 'sessions')); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await pi.createAgentSession({ cwd: dir, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), settingsManager, resourceLoader: loader, sessionManager: manager, tools: ['spawn'] })).session;
    await session.bindExtensions({ mode: 'tui', onError: e => errors.push(e.error), uiContext: { ...session.extensionRunner!.getUIContext(), notify: () => {}, setStatus: () => {} } });
    session.subscribe(event => {
      if (event.type === 'message_end') {
        const m = event.message, text = textContent('content' in m ? m.content : undefined);
        observed.push(`${m.role}: ${text}`);
      }
      if (event.type === 'agent_settled' && mainCalls >= 3) timer(released ? finishWake : settled, 0);
    });
    await session.prompt('Initialize synthetic session.');
    assert.ok(fire); fire();
    await wakeSettled;
    assert.ok(workerStarted, `spawn did not launch worker: ${observed.join('\n')} / ${errors.join('\n')}`);
    const original = manager.getBranch().find(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 'spawn-one');
    assert.ok(original && original.type === 'message' && original.message.role === 'toolResult' && !original.message.isError, 'the original spawn tool call must succeed');
    assert.match(textContent(original.message.content), /^Started: [a-z0-9-]+\./);
    if (criterion === 'second spawn') assert.equal(manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 'spawn-two').length, 0, 'retry must not lead to a second spawn');
    if (criterion === 'Slack final') assert.equal(requests.filter(r => r.path === '/v1/slack/send' && r.body?.channel === 'wakes').length, 0, 'wake is still in progress, not a final Slack report');
    if (criterion === 'Home idle') assert.notEqual(requests.filter(r => r.path === '/v1/slack/home').at(-1)?.body?.working, false, 'Home must not show idle while this wake is waiting');
    if (criterion === 'empty retry') assert.equal(observed.some(text => text.includes('This wake is about to end without delivering a change')), false, 'owned worker must hold this wake instead of injecting empty retry');
    if (criterion === 'human input') {
      human = true;
      await session.prompt('[Slack] Human input during hold.');
      assert.ok(observed.some(text => text.includes('Human input during hold.')));
      assert.equal(requests.filter(r => r.path === '/v1/slack/send' && r.body?.channel === 'wakes').length, 0);
      assert.ok(requests.some(r => r.path === '/v1/slack/send' && r.body?.channel !== 'wakes' && JSON.stringify(r.body).includes('Worker is running.')), 'human receives a reply during the hold');
    }
    released = true;
    if (criterion === 'lost report') {
      assert.ok(expireWorker); now += 30 * 60_000; expireWorker();
    } else releases.splice(0).forEach(release => release());
    await wakeFinished;
    assert.ok(observed.some(text => text.includes('Worker report processed.')));
    assert.equal(manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 'spawn-two').length, 0);
    assert.equal(requests.filter(r => r.path === '/v1/slack/send' && r.body?.channel === 'wakes').length, 1);
    if (criterion === 'lost report') assert.match(JSON.stringify(requests), /Continuação do worker não verificada/);
  } finally {
    for (const release of releases) release();
    if (session) { await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (previous === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = previous;
    removeDir(dir);
  }
});
