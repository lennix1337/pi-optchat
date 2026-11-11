import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { isCompaction, removeDir } from './support.ts';
import { emptyUsage } from '../src/usage.ts';

const COUNT = 12;
const texts = Array.from({ length: COUNT }, (_, i) => `[burst${String(i).padStart(2, '0')}] child ${i} done`);

/**
 * Pi 1.5 starts a turn from `sendUserMessage` after asynchronous checks and refuses every further send made in the meantime
 * ("Agent is already processing a prompt"); the extension runtime reports that only through `onError`. The Pi installed for
 * the tests (1.2) queues those sends instead, so this puts the 1.5 refusal in front of it.
 */
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

/** Pi session on a fixture model that records every message of every request, started on a journal holding `texts`. */
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
