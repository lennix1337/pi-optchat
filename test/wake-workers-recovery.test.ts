import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import * as pinnedPi from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { readHeartbeat } from '../src/heartbeat.ts';
import { textContent, withoutFullChat } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

const pi: typeof pinnedPi = process.env.OPTCHAT_TEST_PI_ENTRY
  ? await import(pathToFileURL(process.env.OPTCHAT_TEST_PI_ENTRY).href) : pinnedPi;

for (const mode of ['in the same wake', 'after profile reopen', 'when delivered twice'] as const) test(`${mode === 'when delivered twice' ? 'a worker report' : 'an observed aborted worker report'} is processed once ${mode}`, { timeout: 20000 }, async t => {
  const reopen = mode === 'after profile reopen', twice = mode === 'when delivered twice';
  const dir = mkdtempSync(join(tmpdir(), 'wake-recover-')), oldHome = process.env.OPTCHAT_HOME, oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.OPTCHAT_HOME = dir; process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('external fetch forbidden'); });
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: any[]) {
    const target = args[0];
    if (!(typeof target === 'string' && !/^\d+$/.test(target) || target && typeof target === 'object' && typeof target.path === 'string' && target.port === undefined && target.host === undefined)) throw new Error('network socket forbidden');
    return (connect as Function).apply(this, args);
  });
  const timer = setTimeout; let fire: (() => void) | undefined;
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 60_000 && !fire) { fire = () => fn(...args); const h = timer(() => {}, 60_000); h.unref(); return h; }
    return timer(fn, delay, ...args);
  }) as typeof setTimeout);
  const until = async (f: () => boolean, label: string) => {
    for (const end = Date.now() + 6000; !f();) { if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => timer(r, 10)); }
  };
  let session: Awaited<ReturnType<typeof pinnedPi.createAgentSession>>['session'] | undefined;
  let repeatReport: (() => void) | undefined, workerFinish: (() => void) | undefined, reportHeld = false, drop = false, dropped = 0, reopened = twice, processed = 0, step = 0, spawns = 0;
  const errors: string[] = [], reportInputs: string[] = [];
  try {
    createProfile('fixture'); const profile = profilePath('fixture'), choice = { provider: 'fixture', model: 'main', thinking: 'off' as const };
    saveConfig(profile, { ...loadConfig(profile), heartbeatMinutes: 1, heartbeatAlways: true, heartbeatWakes: 1, compactor: choice, subagent: { ...choice, model: 'child' } });
    const runtime = await pi.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { api: 'openai-completions', apiKey: 'synthetic', baseUrl: 'https://invalid.local',
      models: ['main', 'child'].map(id => ({ id, name: id, reasoning: false, input: ['text'] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 })),
      streamSimple(model, context, options) {
        const child = model.id === 'child', compression = isCompaction(context), last = withoutFullChat(textContent(context.messages.at(-1)?.content)), report = last.split('</chat>').at(-1)!.trim().endsWith('Child finished.');
        if (report && !child && !compression) reportInputs.push(last);
        const current = child || compression || report ? -1 : step++;
        if (current === 1) spawns++;
        const content: AssistantMessage['content'] = current === 1 ? [{ type: 'toolCall', id: 'spawn-one', name: 'spawn', arguments: { tasks: [{ task: 'SYNTHETIC CHILD TASK' }] } }]
          : [{ type: 'text', text: child ? 'Child finished.' : report ? 'Report processed.' : 'ok' }];
        const stopReason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
        const message: AssistantMessage = { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        const finish = () => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); };
        if (child && !compression) workerFinish = finish;
        else if (report && !reopened) {
          reportHeld = true;
          options?.signal?.addEventListener('abort', () => { stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } }); stream.end(); }, { once: true });
        } else { if (report) processed++; if (twice && report) { timer(() => repeatReport?.(), 10); timer(finish, 60); } else queueMicrotask(finish); }
        return stream;
      } });
    const settingsManager = pi.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
    const open = async () => {
      const loader = new pi.DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
        disabledBuiltinExtensions: ['mcp', 'codemode'], extensionFactories: [(api: pinnedPi.ExtensionAPI) => {
          const send = api.sendMessage.bind(api);
          api.sendMessage = ((message: any, options: any) => {
            if (drop && typeof message.content === 'string' && message.content.includes('Child finished.')) { dropped++; return; }
            send(message, options);
            if (twice && typeof message.content === 'string' && message.content.includes('Child finished.')) repeatReport = () => send(message, options);
          }) as typeof api.sendMessage;
          optchat(api);
        }] });
      await loader.reload(); const manager = pi.SessionManager.create(dir, join(dir, 'sessions')); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
      const s = (await pi.createAgentSession({ cwd: dir, modelRuntime: runtime, model: runtime.getModel('fixture', 'main'), settingsManager, resourceLoader: loader, sessionManager: manager, tools: ['spawn'] })).session;
      await s.bindExtensions({ mode: 'tui', onError: e => errors.push(e.error), uiContext: { ...s.extensionRunner!.getUIContext(), notify: () => {}, setStatus: () => {} } });
      return s;
    };
    session = await open(); await session.prompt('Initialize.'); assert.ok(fire); fire();
    await until(() => !!workerFinish && session!.isIdle, 'wake held for worker');
    workerFinish!();
    if (!twice) { await until(() => reportHeld, 'report observed by model'); drop = reopen; reopened = !reopen; await session.abort(); }
    if (reopen) {
      await until(() => session!.isIdle && dropped > 0, 'abort settles and redelivery is lost');
      assert.match(readFileSync(join(profile, 'pending-reports.json'), 'utf8'), /Child finished/);
      const logged = readdirSync(join(profile, 'main')).flatMap(file => readFileSync(join(profile, 'main', file), 'utf8').split('\n'));
      assert.ok(logged.some(line => line.includes('Child finished.') && line.includes('report:')), 'observation receipt was already journaled');
      await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); session = undefined;
      reopened = true; drop = false; session = await open();
    }
    await until(() => processed > 0 && session!.isIdle, 'saved report processed');
    assert.equal(processed, 1, JSON.stringify(reportInputs)); assert.equal(spawns, 1, 'no worker effect was replayed'); assert.deepEqual(JSON.parse(readFileSync(join(profile, 'pending-reports.json'), 'utf8')).filter((r: { text: string }) => twice ? r.text.includes('Child finished.') : true), []);
    const logged = readdirSync(join(profile, 'main')).flatMap(file => readFileSync(join(profile, 'main', file), 'utf8').split('\n'));
    assert.equal(logged.filter(line => line.includes('Child finished.') && line.includes('report:')).length, 1, 'the report is journaled once');
    assert.deepEqual(errors, []);
  } finally {
    workerFinish?.();
    if (session) { await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    removeDir(dir);
  }
});

test('a wake that resumes a finished worker with tell waits for that worker\'s report before it ends', { timeout: 20000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-tell-')), oldHome = process.env.OPTCHAT_HOME, oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.OPTCHAT_HOME = dir; process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('external fetch forbidden'); });
  const timer = setTimeout; let fire: (() => void) | undefined;
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 60_000 && !fire) { fire = () => fn(...args); const h = timer(() => {}, 60_000); h.unref(); return h; }
    return timer(fn, delay, ...args);
  }) as typeof setTimeout);
  const until = async (f: () => boolean, label: string) => {
    for (const end = Date.now() + 8000; !f();) { if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => timer(r, 10)); }
  };
  let session: Awaited<ReturnType<typeof pinnedPi.createAgentSession>>['session'] | undefined;
  let workerFinish: (() => void) | undefined, woken = false, tells = 0, spawns = 0, processed = 0, firstReports = 0;
  const errors: string[] = [];
  try {
    createProfile('fixture'); const profile = profilePath('fixture'), choice = { provider: 'fixture', model: 'main', thinking: 'off' as const };
    saveConfig(profile, { ...loadConfig(profile), heartbeatMinutes: 1, heartbeatAlways: true, heartbeatWakes: 1, compactor: choice, subagent: { ...choice, model: 'child' } });
    const runtime = await pi.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { api: 'openai-completions', apiKey: 'synthetic', baseUrl: 'https://invalid.local',
      models: ['main', 'child'].map(id => ({ id, name: id, reasoning: false, input: ['text'] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 })),
      streamSimple(model, context) {
        const child = model.id === 'child', compression = isCompaction(context), lastMessage = context.messages.at(-1);
        const last = withoutFullChat(textContent(lastMessage?.content)).split('</chat>').at(-1)!.trim();
        let content: AssistantMessage['content'] = [{ type: 'text', text: 'ok' }], hold = false;
        if (compression) { /* ok */ }
        else if (child) { hold = last.includes('Do more.'); content = [{ type: 'text', text: hold ? 'Child resumed.' : 'Child finished.' }]; }
        else if (lastMessage?.role === 'toolResult') content = [{ type: 'text', text: 'waiting' }];
        else if (last.includes('Initialize.')) { spawns++; content = [{ type: 'toolCall', id: 'spawn-one', name: 'spawn', arguments: { tasks: [{ task: 'SYNTHETIC CHILD TASK' }] } }]; }
        else if (last.includes('Child resumed.')) { processed++; content = [{ type: 'text', text: 'Report processed.' }]; }
        else if (last.includes('Child finished.')) firstReports++;
        else if (woken && !tells) {
          const started = context.messages.map(m => /Started: (\w+)\./.exec(textContent(m.content))?.[1]).find(Boolean);
          tells++; content = [{ type: 'toolCall', id: 'tell-one', name: 'tell', arguments: { id: started ?? '', message: 'Do more.' } }];
        }
        const stopReason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
        const message: AssistantMessage = { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        const finish = () => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); };
        if (hold) workerFinish = finish; else queueMicrotask(finish);
        return stream;
      } });
    const settingsManager = pi.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
    const loader = new pi.DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
      disabledBuiltinExtensions: ['mcp', 'codemode'], extensionFactories: [(api: pinnedPi.ExtensionAPI) => optchat(api)] });
    await loader.reload(); const manager = pi.SessionManager.create(dir, join(dir, 'sessions')); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await pi.createAgentSession({ cwd: dir, modelRuntime: runtime, model: runtime.getModel('fixture', 'main'), settingsManager, resourceLoader: loader, sessionManager: manager, tools: ['spawn', 'tell'] })).session;
    await session.bindExtensions({ mode: 'tui', onError: e => errors.push(e.error), uiContext: { ...session.extensionRunner!.getUIContext(), notify: () => {}, setStatus: () => {} } });
    await session.prompt('Initialize.');
    await until(() => firstReports > 0 && session!.isIdle, 'the first report is processed before the wake');
    assert.ok(fire);
    woken = true; fire();
    await until(() => !!workerFinish && tells === 1 && session!.isIdle, 'the wake resumed the worker with tell');
    await new Promise(r => timer(r, 300));
    await until(() => session!.isIdle, 'the wake turn settled');
    assert.equal(readHeartbeat(profile).wakeLog.at(-1)?.outcome, 'running', 'the wake waits for the worker it resumed');
    workerFinish!();
    await until(() => processed > 0 && session!.isIdle && readHeartbeat(profile).wakeLog.at(-1)?.outcome === 'done', 'the resumed report is processed inside the wake, which then ends');
    assert.equal(processed, 1); assert.equal(spawns, 1); assert.equal(tells, 1, 'no effect was replayed');
    assert.deepEqual(errors, []);
  } finally {
    workerFinish?.();
    if (session) { await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    removeDir(dir);
  }
});
