import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { housekeepingBoundary, housekeepingCut } from '../src/housekeeping.ts';
import { DEFAULT_SETTINGS, readSettings } from '../src/settings.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

const root = mkdtempSync(process.platform === 'win32' ? join(tmpdir(), 'oc-hk-') : '/tmp/oc-hk-');
const oldHome = process.env.OPTCHAT_HOME;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.OPTCHAT_HOME = join(root, 'home');
after(() => {
  if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  removeDir(root);
});

let ids = 0;
const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ids)).toISOString();
const user = (): SessionEntry => ({ type: 'message', id: `e${++ids}`, parentId: null, timestamp: stamp(), message: { role: 'user', content: 'ask', timestamp: ids } });
const assistant = (stopReason: 'stop' | 'toolUse' = 'stop'): SessionEntry => ({ type: 'message', id: `e${++ids}`, parentId: null, timestamp: stamp(),
  message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], api: 'openai-completions', provider: 'p', model: 'm', usage: emptyUsage(), stopReason, timestamp: ids } });
const result = (): SessionEntry => ({ type: 'message', id: `e${++ids}`, parentId: null, timestamp: stamp(), message: { role: 'toolResult', toolCallId: 'c', toolName: 't', content: [{ type: 'text', text: 'out' }], isError: false, timestamp: ids } });
const compaction = (): SessionEntry => ({ type: 'compaction', id: `e${++ids}`, parentId: null, timestamp: stamp(), summary: 's', firstKeptEntryId: 'x', tokensBefore: 1 });
/** n turns of a user message, a tool call, its result and an answer: four messages each. */
const turns = (n: number) => Array.from({ length: n }, () => [user(), assistant('toolUse'), result(), assistant()]).flat();

test('housekeepingCut keeps about `keep` messages from the start of a turn, and only once the context passes twice that', () => {
  assert.equal(housekeepingCut(turns(5), 10), undefined, '20 messages are not over 2 x 10');
  assert.equal(housekeepingCut(turns(6), 0), undefined, 'keep 0 is off');
  const entries = turns(8); // 32 messages
  const cut = housekeepingCut(entries, 10)!;
  const first = entries.findIndex(e => e.id === cut.firstKeptEntryId);
  assert.equal(entries[first].type === 'message' && entries[first].message.role, 'user', 'a turn starts the kept part');
  assert.equal(cut.kept, entries.length - first);
  assert.equal(cut.dropped, first);
  assert.ok(cut.kept >= 10 && cut.kept < 10 + 4, `kept ${cut.kept}`);
});

test('housekeepingCut never starts at a tool result, skips an earlier compaction entry and counts only messages', () => {
  const entries = [compaction(), ...turns(8)];
  const cut = housekeepingCut(entries, 10)!;
  const first = entries.find(e => e.id === cut.firstKeptEntryId)!;
  assert.equal(first.type === 'message' && first.message.role, 'user');
  assert.equal(cut.dropped + cut.kept, 32, 'the compaction entry is not a message');
  // One long turn: no user message after the target, so an assistant message starts the kept part, never a tool result.
  const long = [user(), ...Array.from({ length: 30 }, () => [assistant('toolUse'), result()]).flat()];
  const cutLong = housekeepingCut(long, 10)!;
  const firstLong = long.find(e => e.id === cutLong.firstKeptEntryId)!;
  assert.equal(firstLong.type === 'message' && firstLong.message.role, 'assistant');
});

const event = (over: Partial<Parameters<typeof housekeepingBoundary>[0]> = {}) => ({ outcome: 'completed' as const, continue: false,
  context: { canContinue: false, pendingMessages: [] as never[], contextEntries: [], contextMessages: [], llmMessages: [] }, ...over });

test('the boundary writes one flagged compaction with the cut, and nothing while Pi is not at the end of a run', () => {
  const entries = turns(8);
  const own = housekeepingBoundary(event(), entries, 10)!;
  assert.equal(own.entries!.length, 1);
  const draft = own.entries![0];
  assert.equal(draft.type, 'compaction');
  assert.deepEqual(draft.type === 'compaction' && draft.details, { optchat: true, housekeeping: true });
  assert.equal(draft.type === 'compaction' && draft.firstKeptEntryId, housekeepingCut(entries, 10)!.firstKeptEntryId);
  assert.match(draft.type === 'compaction' ? draft.summary : '', /^Limpeza de RAM do Pi, sem modelo e sem resumo: \d+ mensagens antigas/);
  const refused: [string, Parameters<typeof event>[0], number][] = [
    ['a run that failed (a retry may follow)', { outcome: 'error' }, 10],
    ['a continuation asked for', { continue: true }, 10],
    ['a queued message', { context: { ...event().context, pendingMessages: [user().type as never] } }, 10],
    ['a context that can continue', { context: { ...event().context, canContinue: true } }, 10],
    ['transcriptKeep 0', {}, 0],
    ['a small context', {}, 100],
  ];
  for (const [name, over, keep] of refused) assert.equal(housekeepingBoundary(event(over), entries, keep), undefined, name);
});

test('transcriptKeep defaults to 400, accepts 0 and refuses a negative or fractional value', () => {
  assert.equal(DEFAULT_SETTINGS.transcriptKeep, 400);
  assert.equal(readSettings({ transcriptKeep: 0 }).transcriptKeep, 0);
  assert.throws(() => readSettings({ transcriptKeep: -1 }), /whole number/);
  assert.throws(() => readSettings({ transcriptKeep: 1.5 }), /whole number/);
});

/** A headless Pi with an OptChat profile; every request the fixture model gets is recorded, with the compaction window marked. */
async function session(name: string, keep: number) {
  createProfile(name);
  saveConfig(profilePath(name), { ...loadConfig(profilePath(name)), transcriptKeep: keep, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
  const dir = mkdtempSync(join(root, 's-'));
  const turns: string[] = [];
  let calls = 0;
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      calls++;
      const last = context.messages.at(-1);
      const prompt = last && 'content' in last ? JSON.stringify(last.content) : '';
      const compacting = prompt.includes('Compaction:');
      if (!compacting) turns.push(JSON.stringify(context));
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compacting ? 'talk: OK' : 'OK' }], api: model.api, provider: model.provider, model: model.id,
        timestamp: 1, stopReason: 'stop', usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    } });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 50 }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: [] });
  session.extensionRunner.setFlagValue('optchat-profile', name);
  session.extensionRunner.setFlagValue('optchat-connect', 'off');
  const errors: string[] = [], notes: string[] = [], events: string[] = [];
  const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), notify: message => { notes.push(message); } };
  await session.bindExtensions({ uiContext, mode: 'print', onError: error => { errors.push(error.error); } });
  session.subscribe(event => {
    if (event.type === 'compaction_start' || event.type === 'compaction_end') events.push(event.type);
    if (event.type === 'entry_appended' && event.entry.type === 'compaction') events.push('boundary compaction');
  });
  const file = manager.getSessionFile()!;
  return { session, manager, file, turns, errors, notes, events, calls: () => calls,
    close: async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); } };
}
const jsonl = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; details?: unknown; message?: { role: string } });

test('after 3 x keep messages the context and chat hold about keep, the file and the entries keep all, and the compaction costs no model call', async () => {
  const pi = await session('hk-bounded', 10);
  try {
    for (let i = 0; i < 15; i++) await pi.session.prompt(`question ${i}`); // 30 messages
    assert.deepEqual(pi.errors, []);
    assert.deepEqual(pi.events, ['boundary compaction'], 'one compaction, written at a run boundary, not by the compactor');
    const lines = jsonl(pi.file);
    const compactions = lines.filter(l => l.type === 'compaction');
    assert.equal(compactions.length, 1, 'one compaction line in the session file');
    assert.deepEqual(compactions[0].details, { optchat: true, housekeeping: true });
    assert.equal(lines.filter(l => l.type === 'message' && l.message?.role === 'user').length, 15, 'every message is still in the file');
    assert.equal(pi.manager.getEntries().filter(e => e.type === 'message' && e.message.role !== 'system').length, 30, 'getEntries is intact');
    const context = pi.manager.buildContextEntries();
    const held = context.filter(e => e.type === 'message').length;
    assert.ok(held < 30 && held <= 2 * 10, `Pi holds ${held} of 30 messages, at most twice transcriptKeep`);
    assert.ok(pi.session.state.messages.length <= held + 2, `Pi's list holds ${pi.session.state.messages.length} messages`);
    assert.equal(pi.calls(), 15, 'one model call per prompt: the compaction made none');
    // A new run of Pi on the same file gets the bounded context.
    const reopened = SessionManager.open(pi.file);
    assert.equal(reopened.buildContextEntries().length, context.length);
    assert.equal(reopened.getEntries().filter(e => e.type === 'message' && e.message.role !== 'system').length, 30);
  } finally { await pi.close(); }
});

test('housekeeping off (transcriptKeep 0) never compacts', async () => {
  const pi = await session('hk-off', 0);
  try {
    for (let i = 0; i < 15; i++) await pi.session.prompt(`question ${i}`);
    assert.deepEqual(pi.events, []);
    assert.equal(jsonl(pi.file).filter(l => l.type === 'compaction').length, 0);
    assert.equal(pi.manager.buildContextEntries().length, pi.manager.getEntries().length);
  } finally { await pi.close(); }
});

/** What the model got, without the clock: summary lines and run markers carry timestamps and receipts that differ between two sessions. */
const normal = (request: string) => request.replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?Z?/g, 'T').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, 'ID')
  .replace(/"timestamp":\d+/g, '"timestamp":0').replace(/\d{2}:\d{2}(:\d{2})?/g, 'HH:MM');

test('the next request is byte-identical with housekeeping on and off', async () => {
  const requests: string[][] = [];
  for (const [name, keep] of [['hk-same-on', 10], ['hk-same-off', 0]] as const) {
    const pi = await session(name, keep);
    try {
      for (let i = 0; i < 15; i++) await pi.session.prompt(`question ${i}`);
      await pi.session.prompt('the final question');
      if (keep) assert.ok(pi.events.length >= 1, 'housekeeping ran in the session that has it on');
      requests.push(pi.turns.map(request => normal(request).replaceAll(name, 'PROFILE').replace(/[\/]s-[A-Za-z0-9]{6}/g, '/SESSION')));
    } finally { await pi.close(); }
  }
  assert.equal(requests[0].length, requests[1].length);
  requests[0].forEach((request, i) => {
    const other = requests[1][i];
    let at = 0; while (at < request.length && request[at] === other[at]) at++;
    assert.equal(request === other, true, `request ${i} differs at ${at}: on ${request.slice(Math.max(0, at - 150), at + 150)} | off ${other.slice(Math.max(0, at - 150), at + 150)}`);
  });
});
