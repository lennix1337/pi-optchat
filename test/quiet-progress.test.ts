import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { REPORT_TYPE, textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

const agentDir = process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
after(() => removeDir(agentDir));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${what}`); await sleep(10); }
}

const PROGRESS = 'Halfway: the parser is done.';

/**
 * A real Pi session with the extension, whose root worker reports progress with tell_parent while the main agent is idle,
 * and only then finishes. `mainRequests` are the model requests of the main agent; the worker's are not counted.
 */
async function withWorker(holdMain: boolean, run: (ctx: { session: Awaited<ReturnType<typeof createAgentSession>>['session']; manager: SessionManager; dir: string;
  mainRequests: Context[]; releaseProgress: () => void; releaseFinish: () => void; releaseMain: () => void }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-quiet-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let releaseProgress!: () => void, releaseFinish!: () => void, releaseMain!: () => void;
  const mainGate = new Promise<void>(resolve => { releaseMain = resolve; });
  const progressGate = new Promise<void>(resolve => { releaseProgress = resolve; });
  const finishGate = new Promise<void>(resolve => { releaseFinish = resolve; });
  const mainRequests: Context[] = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = isCompaction(context);
        const last = context.messages.at(-1);
        const worker = context.messages.some(m => textContent(m.content).includes('Your task:\n'));
        if (!compression && !worker) mainRequests.push(structuredClone(context));
        const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compression ? 'Summary.' : worker ? 'Worker done.' : 'Main done.' }],
          timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
        if (!compression && !worker && last?.role === 'user' && textContent(last.content).endsWith('Spawn one.')) {
          reply.stopReason = 'toolUse';
          reply.content = [{ type: 'toolCall', id: 'spawn-1', name: 'spawn', arguments: { tasks: [{ task: 'report progress' }] } }];
        }
        if (worker && last?.role === 'user') {
          reply.stopReason = 'toolUse';
          reply.content = [{ type: 'toolCall', id: 'tell-1', name: 'tell_parent', arguments: { message: PROGRESS } }];
        }
        const stream = createAssistantMessageEventStream();
        void (async () => {
          if (holdMain && !worker && !compression && last?.role === 'toolResult') { stream.push({ type: 'start', partial: reply }); await mainGate; }
          if (worker && last?.role === 'user') { stream.push({ type: 'start', partial: reply }); await progressGate; }
          if (worker && last?.role === 'toolResult') { stream.push({ type: 'start', partial: reply }); await finishGate; }
          stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply });
          stream.end();
        })();
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', 'spawn'] })).session;
    await session.bindExtensions({});
    await run({ session, manager, dir, mainRequests, releaseProgress, releaseFinish, releaseMain });
  } finally {
    releaseProgress?.(); releaseFinish?.(); releaseMain?.();
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
}

const shown = (manager: SessionManager, needle: string) => manager.getBranch().flatMap(e => e.type === 'custom_message' && e.customType === REPORT_TYPE && textContent(e.content).includes(needle) ? [textContent(e.content)] : []);

test('a worker\'s progress message does not start a turn of an idle main agent, yet is in its next turn', async () => {
  await withWorker(false, async ({ session, manager, dir, mainRequests, releaseProgress, releaseFinish }) => {
    await session.prompt('Spawn one.');
    await session.agent.waitForIdle();
    const turns = mainRequests.length;
    assert.equal(session.isStreaming, false);

    releaseProgress();
    await until(() => shown(manager, PROGRESS).length > 0, 'the progress message in the session');
    await sleep(300); // a turn started by the message would have asked the model by now
    assert.equal(mainRequests.length, turns, 'no new main-agent request: the message started no turn');
    assert.equal(session.isStreaming, false);
    assert.match(shown(manager, PROGRESS)[0], /Message from subagent \(still running\)/);

    // The worker's final report still wakes the main agent, and the progress message is in context by then.
    releaseFinish();
    await until(() => mainRequests.length > turns, 'the final report starting a turn');
    await session.agent.waitForIdle();
    const woken = mainRequests[turns].messages.map(m => textContent(m.content));
    assert.ok(woken.some(text => text.includes(PROGRESS)), 'the progress message is in the context of the next turn');
    assert.ok(woken.some(text => text.includes('Worker done.')), 'the final report is what started that turn');
    const main = join(dir, 'profiles', 'fixture', 'main');
    const logged = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => JSON.parse(line) as { kind: string; text: string });
    assert.ok(logged.some(e => e.kind === 'work' && e.text.includes(PROGRESS)), 'memory keeps it as work, not as something the user typed');
  });
});

test('a worker\'s progress message is still steered into a main agent that is running', async () => {
  await withWorker(true, async ({ session, mainRequests, releaseProgress, releaseFinish, releaseMain }) => {
    const running = session.prompt('Spawn one.');
    // The main agent is held mid-turn, right after its spawn call, while the worker runs.
    await until(() => session.isStreaming && mainRequests.length >= 2, 'the main agent held mid-turn');
    const turns = mainRequests.length;
    releaseProgress();
    await sleep(1_800); // reports that arrive mid-turn gather for 1.5 s before they steer in
    releaseMain();
    await running; await session.agent.waitForIdle();
    const seen = mainRequests.slice(turns).some(r => r.messages.some(m => m.role === 'user' && textContent(m.content).includes(PROGRESS)));
    assert.ok(seen, 'the running turn received the message as steering');
    releaseFinish();
  });
});
