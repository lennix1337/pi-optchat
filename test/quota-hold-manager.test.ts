import './support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import * as pinnedPi from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { QUOTA_FILE } from '../src/quota-health.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

const pi: typeof pinnedPi = process.env.OPTCHAT_TEST_PI_ENTRY
  ? await import(pathToFileURL(process.env.OPTCHAT_TEST_PI_ENTRY).href) : pinnedPi;

const setQuota = (state: object) => { mkdirSync(dirname(QUOTA_FILE), { recursive: true }); writeFileSync(QUOTA_FILE, JSON.stringify(state)); };

for (const recovery of ['its quota returns at the time it was told', 'the operator switches the main model to an account with quota'] as const) test(`while the main agent has no quota, worker reports start no turn and no error; when ${recovery}, even after another account hit a long limit, one turn carries them all, after one notice`, { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-manager-')), oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('external fetch forbidden'); });
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: any[]) {
    const target = args[0];
    if (!(typeof target === 'string' && !/^\d+$/.test(target) || target && typeof target === 'object' && typeof target.path === 'string' && target.port === undefined && target.host === undefined)) throw new Error('network socket forbidden');
    return (connect as Function).apply(this, args);
  });
  // The outage timer is the only one with a delay near 13 minutes: the test holds it and fires it by hand.
  const timer = setTimeout; let fire: (() => void) | undefined;
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay !== undefined && delay >= 770_000 && delay <= 800_000 && !fire) { fire = () => fn(...args); const h = timer(() => {}, 60_000); h.unref(); return h; }
    return timer(fn, delay, ...args);
  }) as typeof setTimeout);
  const until = async (f: () => boolean, label: string) => {
    for (const end = Date.now() + 8000; !f();) { if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => timer(r, 10)); }
  };
  const errors: string[] = [], notices: string[] = [], finishers = new Map<string, () => void>(), reportRequests: string[] = [];
  let session: Awaited<ReturnType<typeof pinnedPi.createAgentSession>>['session'] | undefined, mainCalls = 0, turns = 0;
  try {
    setQuota({});
    createProfile('fixture'); const profile = profilePath('fixture'), choice = { provider: 'fixture', model: 'main', thinking: 'off' as const };
    saveConfig(profile, { ...loadConfig(profile), compactor: choice, subagent: { ...choice, model: 'child' } });
    const runtime = await pi.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { api: 'openai-completions', apiKey: 'synthetic', baseUrl: 'https://invalid.local',
      models: ['main', 'child'].map(id => ({ id, name: id, reasoning: false, input: ['text'] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 })),
      streamSimple(model, context) {
        const child = model.id === 'child', compression = isCompaction(context), last = textContent(context.messages.at(-1)?.content);
        let content: AssistantMessage['content'] = [{ type: 'text', text: 'ok' }];
        if (child) {
          const task = textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
          content = [{ type: 'text', text: `Finished ${task}.` }];
          const message: AssistantMessage = { role: 'assistant', content, stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
          const stream = createAssistantMessageEventStream();
          finishers.set(task, () => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
          return stream;
        }
        if (!compression) {
          mainCalls++;
          if (last.includes('Initialize.')) content = [{ type: 'toolCall', id: 'spawn-three', name: 'spawn', arguments: { tasks: ['ONE', 'TWO', 'THREE'].map(task => ({ task })) } }];
          else if (last.includes('Finished')) { reportRequests.push(context.messages.map(m => textContent(m.role === 'toolResult' ? [] : m.content as never)).join('\n')); content = [{ type: 'text', text: 'Reports processed.' }]; }
        }
        const stopReason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
        const message: AssistantMessage = { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); });
        return stream;
      } });
    const settingsManager = pi.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
    const loader = new pi.DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
      disabledBuiltinExtensions: ['mcp', 'codemode'], extensionFactories: [(api: pinnedPi.ExtensionAPI) => optchat(api)] });
    await loader.reload(); const manager = pi.SessionManager.create(dir, join(dir, 'sessions')); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await pi.createAgentSession({ cwd: dir, modelRuntime: runtime, model: runtime.getModel('fixture', 'main'), settingsManager, resourceLoader: loader, sessionManager: manager, tools: ['spawn'] })).session;
    await session.bindExtensions({ mode: 'tui', onError: e => errors.push(e.error), uiContext: { ...session.extensionRunner!.getUIContext(), notify: text => { notices.push(text); }, setStatus: () => {} } });
    session.subscribe(event => { if (event.type === 'agent_start') turns++; });

    await session.prompt('Initialize.');
    await until(() => finishers.size === 3 && session!.isIdle, 'three workers started');
    const quiet = { turns, mainCalls };

    // Every model of the main agent's account is out of quota for 13 minutes; the workers finish meanwhile.
    setQuota({ exhaustedUntilByProvider: { fixture: Date.now() + 777_000 } });
    for (const finish of finishers.values()) finish();
    await until(() => !!fire, 'the held reports armed the outage timer');
    await new Promise(r => timer(r, 300));
    assert.equal(turns, quiet.turns, 'no turn started for the reports while the account is out');
    assert.equal(mainCalls, quiet.mainCalls, 'and no model request');
    assert.deepEqual(errors, []);
    const outageNotices = notices.filter(text => /cota esgotada/.test(text));
    assert.equal(outageNotices.length, 1, `one notice: ${JSON.stringify(notices)}`);
    assert.match(outageNotices[0], /^cota esgotada em todas as contas; volto às \d\d:\d\d \(Brasília\)$/);

    // The failover tried another account meanwhile and got a 16-hour limit: it says nothing about the main agent's account.
    const failed: AssistantMessage = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'You have hit your ChatGPT usage limit (team plan). Try again in ~998 min.',
      api: 'openai-completions', provider: 'other-account', model: 'main', timestamp: Date.now(), usage: emptyUsage() };
    await session.extensionRunner!.emit({ type: 'message_end', message: failed } as never);
    setQuota({});
    if (recovery.startsWith('its')) fire!();
    else await session.extensionRunner!.emit({ type: 'model_select', model: runtime.getModel('fixture', 'child'), previousModel: runtime.getModel('fixture', 'main'), source: 'set' } as never);
    await until(() => reportRequests.length > 0 && session!.isIdle, 'the held reports processed');
    await new Promise(r => timer(r, 300));
    assert.equal(turns, quiet.turns + 1, 'one turn for all the reports');
    const seen = reportRequests.at(-1)!;
    for (const task of ['ONE', 'TWO', 'THREE']) assert.ok(seen.includes(`Finished ${task}.`), `the turn carries the report of ${task}`);
    assert.equal(notices.filter(text => /cota esgotada/.test(text)).length, 1, 'still one notice');
    assert.deepEqual(errors, []);
  } finally {
    for (const finish of finishers.values()) { try { finish(); } catch { /* already finished */ } }
    if (session) { await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});
