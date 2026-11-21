import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { reportReceipt, textContent } from '../src/transcript.ts';
import { isCompaction, removeDir } from './support.ts';
import { emptyUsage } from '../src/usage.ts';
import { memoryDirectory } from '../src/import/job.ts';

const COUNT = 12;
const texts = Array.from({ length: COUNT }, (_, i) => `[burst${String(i).padStart(2, '0')}] child ${i} done`);

// external: Pi 1.5 can reject additional sends while a turn starts; 1.2 queues them.
const refuseConcurrentStarts = (session: Awaited<ReturnType<typeof createAgentSession>>['session']) => {
  let starting = false;
  session.subscribe(event => { if (event.type === 'agent_start' || event.type === 'agent_end') starting = false; });
  const send = session.sendUserMessage.bind(session);
  session.sendUserMessage = async (content, options) => {
    if (starting && !session.isStreaming) throw new Error('Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.');
    if (!session.isStreaming) starting = true;
    return send(content, options);
  };
};


const withJournal = async (run: (ctx: { profile: string; seen: Set<string>; errors: string[]; session: Awaited<ReturnType<typeof createAgentSession>>['session'] }) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-burst-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const seen = new Set<string>();
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const profile = profilePath('fixture');
    saveConfig(profile, { ...loadConfig(profile), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    writeFileSync(join(profile, 'pending-reports.json'), JSON.stringify(texts.map(text => ({ text, count: 1 }))));
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context: Context) {
        if (!isCompaction(context)) for (const m of context.messages) seen.add(textContent(m.content));
        const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        setTimeout(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); }, 20);
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
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] })).session;
    const errors: string[] = [];
    refuseConcurrentStarts(session);
    await session.bindExtensions({ onError: error => errors.push(`${error.event}: ${error.error}`) });
    await run({ profile, seen, errors, session });
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
};

test('a burst of reports journaled before a reload all reach the model once the session starts idle', async () => {
  await withJournal(async ({ profile, seen, errors, session }) => {
    const missing = () => texts.filter(t => ![...seen].some(s => s.includes(t)));
    for (const deadline = Date.now() + 15_000; missing().length && Date.now() < deadline;) await new Promise(r => setTimeout(r, 25));
    await session.agent.waitForIdle();
    assert.deepEqual(missing(), [], `reports lost at startup (Pi errors: ${errors.join('; ') || 'none'})`);
    assert.deepEqual(errors, []);
    assert.deepEqual(JSON.parse(readFileSync(join(profile, 'pending-reports.json'), 'utf8')), [], 'every delivered report left the journal');
  });
});

test('the burst reaches the model as one message, and every report in it is logged under its own receipt', async () => {
  await withJournal(async ({ profile, seen, errors, session }) => {
    const holders = () => [...seen].filter(s => texts.some(t => s.includes(t)));
    for (const deadline = Date.now() + 15_000; !texts.every(t => holders().some(s => s.includes(t))) && Date.now() < deadline;) await new Promise(r => setTimeout(r, 25));
    await session.agent.waitForIdle();
    assert.equal(holders().length, 1, 'one message carries all the reports');
    assert.deepEqual(texts.filter(t => !holders()[0].includes(t)), []);
    assert.deepEqual(errors, []);
    assert.deepEqual(JSON.parse(readFileSync(join(profile, 'pending-reports.json'), 'utf8')), []);
    const logged = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map(e => e.isDirectory() ? logged(join(dir, e.name)) : e.name.endsWith('.json') || e.name.endsWith('.jsonl') ? readFileSync(join(dir, e.name), 'utf8') : '').join('\n');
    const memory = logged(memoryDirectory(profile));
    for (const text of texts) assert.ok(memory.includes(text) && memory.includes(reportReceipt(text)), `${text} is in memory under its own receipt`);
  });
});
