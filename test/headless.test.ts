import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type Api, type Context, type Model, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, lastProfile, loadConfig, lockProfile, profilePath, rememberProfile, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

// Short paths: the profile lock socket has a ~103-byte limit on macOS. Windows uses a hashed named pipe, so any directory fits.
const root = mkdtempSync(process.platform === 'win32' ? join(tmpdir(), 'oc-headless-') : '/tmp/oc-headless-');
const oldHome = process.env.OPTCHAT_HOME;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.OPTCHAT_HOME = join(root, 'home');
after(() => {
  if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  removeDir(root);
});
for (const name of ['work', 'personal']) {
  createProfile(name);
  saveConfig(profilePath(name), { ...loadConfig(profilePath(name)), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
}
rememberProfile('personal');
// A profile whose shells report only failures: the default for a shell_start without notify.
createProfile('failures');
saveConfig(profilePath('failures'), { ...loadConfig(profilePath('failures')), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' }, shellNotify: 'failure' });

/** A scripted tool call the fixture model makes instead of answering (see `script`). */
type ScriptedCall = { name: string; arguments: Record<string, string | number | boolean> };
let scriptedCalls = 0;
function fixtureContent(text: string, refused: boolean, writeProbe: boolean, call?: ScriptedCall): AssistantMessage['content'] {
  if (refused) return [];
  if (call) return [{ type: 'toolCall', id: `scripted-${++scriptedCalls}`, name: call.name, arguments: call.arguments }];
  if (writeProbe) return [{ type: 'toolCall', id: 'isolated-write-probe', name: 'write', arguments: { path: 'benchmark-probe.txt', content: 'real OptChat tool execution' } }];
  return [{ type: 'text', text }];
}
function fixtureStream(model: Model<Api>, text: string, refused = false, hold: Promise<void> = Promise.resolve(), writeProbe = false, call?: ScriptedCall) {
  const toolUse = Boolean(call || writeProbe);
  const message: AssistantMessage = { role: 'assistant', content: fixtureContent(text, refused, writeProbe, call),
    api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: refused ? 'error' : toolUse ? 'toolUse' : 'stop', usage: emptyUsage(),
    ...(refused ? { errorMessage: 'Request blocked by provider usage policy' } : {}) };
  const stream = createAssistantMessageEventStream();
  void hold.then(() => {
    stream.push({ type: 'start', partial: message });
    if (refused) stream.push({ type: 'error', reason: 'error', error: message });
    else stream.push({ type: 'done', reason: toolUse ? 'toolUse' : 'stop', message });
    stream.end();
  });
  return stream;
}

/** A headless Pi (print or RPC) with short synthetic compaction summaries and recorded model-turn requests. */
async function headless(mode: 'print' | 'rpc' | 'tui', options: { writeProbe?: boolean; realTools?: boolean; flag?: string; bound?: string; connect?: string; agent?: string; hold?: Promise<void>; later?: ExtensionFactory; refuseSummaries?: () => boolean;
  /** Makes the fixture call a tool instead of answering, from the context it is given; undefined answers with text. */
  script?: (messages: Context['messages']) => ScriptedCall | undefined } = {}) {
  const dir = mkdtempSync(join(root, 's-'));
  const sent: string[] = [], turns: string[] = [], errors: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  let probePending = options.writeProbe;
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const request = JSON.stringify(context.messages);
      sent.push(request);
      const last = context.messages.at(-1);
      const prompt = textContent(last && 'content' in last ? last.content : '');
      const compacting = prompt.includes('\n\nCompaction:');
      if (!compacting) turns.push(request);
      const text = compacting ? 'talk: OK' : `OK to: ${prompt}`;
      const refused = compacting && options.refuseSummaries?.();
      const writeProbe = probePending;
      probePending = false;
      // Scripts only match the probe prompts and their own results, so compaction requests pass through as text.
      const call = options.script?.(context.messages);
      return fixtureStream(model, text, refused, prompt.includes('slow') ? options.hold : undefined, writeProbe, call);
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat, ...options.later ? [options.later] : []] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  if (options.bound) manager.appendCustomEntry('optchat.profile', { name: options.bound });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: options.realTools ? undefined : [] });
  if (options.flag) session.extensionRunner.setFlagValue('optchat-profile', options.flag);
  if (options.agent !== undefined) session.extensionRunner.setFlagValue('optchat-agent', options.agent);
  if (options.connect) session.extensionRunner.setFlagValue('optchat-connect', options.connect);
  // RPC hosts have a real UI, but a dialog there can hang the host (pi-acp), so any select fails the test.
  const notes: string[] = [];
  const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), notify: message => { notes.push(message); },
    select: async () => { throw new Error('a headless session must not ask for a profile'); } };
  await session.bindExtensions({ uiContext, mode, onError: error => { errors.push(error.error); } });
  const ask = async (text: string) => {
    await session.prompt(text);
    const reply = session.state.messages.at(-1);
    return reply?.role === 'assistant' ? textContent(reply.content) : undefined;
  };
  const bindings = () => manager.getEntries().flatMap(e => e.type === 'custom' && e.customType === 'optchat.profile' ? [e.data] : []);
  const close = async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); };
  return { ask, bindings, close, errors, notes, sent, turns, dir, activeTools: () => session.getActiveToolNames(), compact: () => session.compact() };
}

test('optchat-perf exposes actual SDK tool failures without another model request or error text', async () => {
  const previousProfile = lastProfile()!;
  const pi = await headless('print', {
    flag: 'work', connect: 'off', realTools: true,
    later: api => {
      api.registerTool({ name: 'diagnostic_probe', label: 'Diagnostic probe', description: 'Offline fixture',
        parameters: Type.Object({ fail: Type.Boolean() }),
        async execute(_id, args) {
          if (args.fail) throw new Error('PRIVATE_TOOL_FAILURE');
          return { content: [{ type: 'text', text: 'PRIVATE_TOOL_OUTPUT' }], details: {} };
        } });
      api.on('session_start', () => api.setActiveTools([...api.getActiveTools(), 'diagnostic_probe']));
    },
    script: messages => {
      const last = messages.at(-1), text = last ? textContent(last.content) : '';
      if (last?.role === 'user' && /diagnostic probe (ok|fail)$/.test(text))
        return { name: 'diagnostic_probe', arguments: { fail: text.endsWith('fail') } };
      return undefined;
    },
  });
  try {
    await pi.ask('diagnostic probe ok');
    await pi.ask('diagnostic probe fail');
    const requests = pi.sent.length;
    await pi.ask('/optchat-perf');
    assert.equal(pi.sent.length, requests, 'the command is local, with no model request');
    const note = pi.notes.at(-1)!;
    const report = JSON.parse(note);
    assert.equal(report.tools.diagnostic_probe.count, 2);
    assert.equal(report.tools.diagnostic_probe.errors, 1);
    assert.doesNotMatch(note, /PRIVATE_TOOL_FAILURE|PRIVATE_TOOL_OUTPUT/);
    assert.deepEqual(pi.errors, []);
  } finally { await pi.close(); rememberProfile(previousProfile); }
});

test('a headless run without a binding or --optchat-profile is plain Pi: it answers, and no profile is picked or created', async () => {
  for (const mode of ['print', 'rpc'] as const) {
    const pi = await headless(mode);
    try {
      assert.equal(await pi.ask('Say OK'), 'OK to: Say OK', `${mode}: the prompt reaches the model`);
      assert.deepEqual(pi.errors, []);
      assert.deepEqual(pi.bindings(), [], `${mode}: the session stays unbound`);
      assert.doesNotMatch(pi.sent[0], /You are OptChat/, `${mode}: Pi's own prompt is untouched`);
    } finally { await pi.close(); }
  }
  assert.ok(!existsSync(profilePath('default')), 'no default profile is created');
  assert.equal(lastProfile(), 'personal', 'the last-used profile is unchanged');
});

test('--optchat-profile still opens that profile headlessly', async () => {
  const pi = await headless('print', { flag: 'work' });
  try {
    assert.match(await pi.ask('Say OK') ?? '', /^OK to: <chat>[^]*Say OK$/, 'the prompt runs with the OptChat view');
    assert.deepEqual(pi.errors, []);
    assert.deepEqual(pi.bindings(), [{ name: 'work' }]);
    assert.match(pi.sent[0], /You are OptChat/);
  } finally { await pi.close(); }
});

test('benchmark acceptance: real OptChat profile projects persisted history and exposes its actual tools', async () => {
  const pi = await headless('rpc', { flag: 'work', connect: 'off', realTools: true });
  try {
    assert.deepEqual(pi.bindings(), [{ name: 'work' }], 'the benchmark must not silently run bare Pi');
    for (const name of ['zoom', 'shell_start', 'shell_status', 'shell_stop']) {
      assert.ok(pi.activeTools().includes(name), `real OptChat tool missing: ${name}`);
    }
    await pi.ask('Benchmark continuity sentinel 4f82');
    await pi.ask('Recall the previous benchmark sentinel');
    assert.equal(pi.turns.length, 2);
    assert.match(pi.turns[1], /You are OptChat/);
    assert.match(pi.turns[1], /<chat>/);
    assert.match(pi.turns[1], /Benchmark continuity sentinel 4f82/);
    assert.deepEqual(pi.errors, []);
  } finally { await pi.close(); }
});

test('benchmark acceptance: real OptChat executes its write tool and returns the result to the model', async () => {
  const pi = await headless('rpc', { flag: 'work', connect: 'off', realTools: true, writeProbe: true });
  try {
    await pi.ask('Execute the isolated benchmark write probe');
    assert.equal(readFileSync(join(pi.dir, 'benchmark-probe.txt'), 'utf8'), 'real OptChat tool execution');
    const journal = JSON.parse(readFileSync(join(profilePath('work'), 'operations.json'), 'utf8'));
    const receipt = journal.operations.find((entry: { id: string }) => entry.id.includes('isolated-write-probe'));
    assert.equal(receipt?.dispatchObserved, true, 'actual Pi dispatch precedes intent and is correlated to the response');
    assert.equal(receipt.status, 'response_recorded');
    assert.equal(receipt.outcome, 'not_verified', 'a response alone is not independent verification');
    assert.ok(receipt.responseAt >= receipt.startedAt);
    assert.equal(pi.turns.length, 2, 'the model receives a second turn after actual tool execution');
    assert.match(pi.turns[1], /toolResult/);
    assert.deepEqual(pi.bindings(), [{ name: 'work' }]);
    assert.deepEqual(pi.errors, []);
  } finally { await pi.close(); }
});

test('OPTCHAT_PROFILE opens that profile in the TUI without the picker, and headless runs ignore it', async () => {
  process.env.OPTCHAT_PROFILE = 'work';
  try {
    const tui = await headless('tui');
    try {
      assert.match(await tui.ask('Say OK') ?? '', /^OK to: <chat>[^]*Say OK$/);
      assert.deepEqual(tui.errors, []);
      assert.deepEqual(tui.bindings(), [{ name: 'work' }]);
    } finally { await tui.close(); }
    const print = await headless('print');
    try {
      assert.equal(await print.ask('Say OK'), 'OK to: Say OK');
      assert.deepEqual(print.bindings(), []);
    } finally { await print.close(); }
  } finally { delete process.env.OPTCHAT_PROFILE; }
});

test('in an RPC host (Pi Web), /optchat profile <name> as the first message binds that session in place', async () => {
  // No commandContextActions are bound, so ctx.newSession() throws, as Pi Web's does.
  const pi = await headless('rpc');
  try {
    await pi.ask('/optchat profile work');
    assert.deepEqual(pi.bindings(), [{ name: 'work' }]);
    assert.match(await pi.ask('Say OK') ?? '', /^OK to: <chat>[^]*Say OK$/, 'the next prompt runs with the OptChat view');
    assert.match(pi.sent[0], /You are OptChat/);
    await pi.ask('/optchat profile personal');
    assert.deepEqual(pi.bindings(), [{ name: 'work' }], 'a session with messages keeps its profile');
    assert.match(pi.notes.at(-1) ?? '', /^Run \/optchat profile personal as the first message of a new session/);
    assert.deepEqual(pi.errors, []);
  } finally { await pi.close(); }
});

test('in an RPC host, /optchat profile <name> that cannot open saves no binding and blocks prompts instead of running without memory', async () => {
  const unlock = await lockProfile(profilePath('work'), 'work · PID 1 · elsewhere');
  try {
    for (const [why, name, error] of [['typo', 'wrok', /does not exist/], ['busy', 'work', /Profile already running/]] as const) {
      const pi = await headless('rpc');
      try {
        await pi.ask(`/optchat profile ${name}`);
        assert.match(pi.notes.at(-1) ?? '', error, `${why}: the command says why`);
        assert.equal(await pi.ask('Say OK'), undefined, `${why}: the prompt is not answered`);
        assert.equal(pi.sent.length, 0, `${why}: nothing reaches the model`);
        assert.deepEqual(pi.bindings(), [], `${why}: no binding is saved`);
      } finally { await pi.close(); }
    }
  } finally { await unlock(); }
});

test('the model gets the system prompt Pi has now, with sections extensions loaded after OptChat add (Pi\'s built-in MCP)', async () => {
  const later: ExtensionFactory = pi => { pi.on('before_agent_start', event => { event.systemPromptOptions.sections.x = 'SECTION-FROM-LATER-EXTENSION'; }); };
  const pi = await headless('print', { flag: 'work', later });
  try {
    await pi.ask('Say OK');
    assert.match(pi.turns[0], /You are OptChat/);
    assert.match(pi.turns[0], /SECTION-FROM-LATER-EXTENSION/);
  } finally { await pi.close(); }
});

test('a requested profile that cannot open fails visibly and does not run without memory', async () => {
  const unlock = await lockProfile(profilePath('work'), 'work · PID 1 · elsewhere');
  try {
    // `auto` would join the busy owner; this one has no windows socket, so the join fails too, with a failing exit code.
    for (const [why, options] of [['typo', { flag: 'wrok' }], ['busy', { bound: 'work', connect: 'off' }], ['busy, nothing to join', { bound: 'work' }],
      ['deleted', { bound: 'gone' }], ['join without a session', { flag: 'personal', connect: 'join' }], ['join with an invalid name', { flag: 'Work', connect: 'join' }]] as const) {
      process.exitCode = undefined;
      const pi = await headless('print', options);
      try {
        assert.equal(pi.errors.length, 1, `${why}: Pi reports the error (stderr in print mode)`);
        assert.equal(await pi.ask('Say OK'), undefined, `${why}: the prompt is not answered without memory`);
        assert.equal(pi.sent.length, 0);
        assert.equal(process.exitCode, why.includes('join') ? 1 : undefined, `${why}: exit code`);
      } finally { await pi.close(); }
    }
  } finally { process.exitCode = undefined; await unlock(); }
});

test('a second pi -p on a profile a headless run owns fails up front, instead of joining and dying when the owner exits', async () => {
  let release = () => {};
  const owner = await headless('print', { flag: 'work', hold: new Promise<void>(resolve => { release = resolve; }) });
  const stderr: string[] = [], write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; };
  process.exitCode = undefined;
  try {
    const second = await headless('print', { flag: 'work' });
    try {
      // The joined task would run in the owner and wait there, so the owner exits mid-task, as `pi -p` does once its own prompt is answered.
      const answer = second.ask('slow joined task');
      let answered = false; void answer.finally(() => { answered = true; });
      while (!answered && !owner.sent.some(s => s.includes('slow joined task'))) await new Promise(resolve => setTimeout(resolve, 10));
      const closed = owner.close(); release(); await closed;
      assert.equal(await answer, undefined);
      assert.doesNotMatch(stderr.join(''), /Connection to the original Pi window was lost/);
      assert.equal(second.errors.length, 1, 'the second run reports the busy profile when it starts');
      assert.match(second.errors[0], /does not accept connections/);
      assert.equal(process.exitCode, 1);
      assert.ok(!owner.sent.some(s => s.includes('slow joined task')), 'nothing of the second run reached the owner');
    } finally { await second.close(); }
  } finally { process.stderr.write = write; process.exitCode = undefined; release(); await owner.close(); }
});

test('an unbound Pi session still uses its own manual compaction instead of OptChat cancellation', async () => {
  const pi = await headless('print');
  try {
    await pi.ask('Synthetic long input. ' + 'padding '.repeat(11000));
    await pi.ask('Summarize briefly.');
    const compact = await pi.compact();
    assert.doesNotMatch(compact.summary, /^<chat>/);
    assert.ok(pi.sent.length > 2, 'plain Pi calls its own summary model');
    assert.deepEqual(pi.errors, []);
  } finally { await pi.close(); }
});

test('--optchat-agent refuses headless mode without opening a profile or answering locally', async () => {
  for (const mode of ['print', 'rpc'] as const) {
    process.exitCode = undefined;
    const pi = await headless(mode, { flag: 'work', agent: '8ab62e89' });
    try {
      assert.equal(pi.errors.length, 1);
      assert.match(pi.errors[0], /requires interactive Pi/);
      assert.equal(await pi.ask('Do not run this locally'), undefined);
      assert.equal(pi.sent.length, 0);
      assert.deepEqual(pi.bindings(), []);
      assert.equal(process.exitCode, 1);
    } finally { await pi.close(); process.exitCode = undefined; }
  }
});

test('the real retry-summary command retries a frozen node without resending the main request or changing models', async () => {
  const name = 'retry-command';
  createProfile(name);
  const dir = profilePath(name), choice = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
  saveConfig(dir, { ...loadConfig(dir), compactor: choice, subagent: choice });
  let refuse = true;
  const pi = await headless('print', { flag: name, refuseSummaries: () => refuse });
  const records = () => readdirSync(join(dir, 'tree')).flatMap(file => readFileSync(join(dir, 'tree', file), 'utf8').trim().split('\n'))
    .filter(Boolean).map(line => JSON.parse(line) as { type?: string; l: number; i: number; text?: string });
  const waitFor = async (predicate: () => boolean) => {
    const deadline = AbortSignal.timeout(5000);
    while (!predicate()) {
      deadline.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await pi.ask('Original request '.repeat(100));
    await waitFor(() => records().some(record => record.type === 'terminal' && record.l === 0));
    const target = records().find(record => record.type === 'terminal' && record.l === 0)!;
    const turnsBefore = pi.turns.length;
    refuse = false;
    await pi.ask(`/optchat retry-summary ${target.i}+1`);
    await waitFor(() => records().some(record => record.l === 0 && record.i === target.i && !!record.text));
    assert.equal(pi.turns.length, turnsBefore, 'the command did not resend the main request');
    assert.ok(pi.notes.some(note => note.includes('Summary retry requested with the current configured compactor')));
    assert.ok(records().some(record => record.type === 'retry' && record.i === target.i));
    assert.deepEqual(loadConfig(dir).compactor, choice, 'no provider/model/effort switch was introduced');
    assert.deepEqual(pi.errors, []);
  } finally { await pi.close(); }
});

/** Drives one background shell through the real shell_start/shell_stop/bash tools; `ids` collects the shell IDs the tools return. */
function shellScript(kind: 'idle' | 'mid' | 'stop', ids: string[]) {
  const quick = `node -e "setTimeout(() => console.log('${kind}-done'), 500)"`;
  return (messages: Context['messages']): ScriptedCall | undefined => {
    const last = messages.at(-1), text = last ? textContent(last.content) : '';
    if (last?.role === 'user' && text.endsWith(`shell probe ${kind}`))
      return { name: 'shell_start', arguments: { command: kind === 'stop' ? `node -e "setInterval(() => {}, 1000)"` : quick } };
    if (last?.role === 'toolResult' && last.toolName === 'shell_start') {
      ids.push(text.match(/Background shell (\S+) started/)?.[1] ?? '');
      if (kind === 'mid') return { name: 'bash', arguments: { command: `node -e "setTimeout(() => {}, 2500)"` } };
      if (kind === 'stop') return { name: 'shell_stop', arguments: { id: ids.at(-1) ?? '' } };
    }
    return undefined;
  };
}
async function until(done: () => boolean, ms = 15_000) {
  for (const deadline = Date.now() + ms; !done() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
}

test('an ended background shell reaches the model once as its own message: between tool calls mid-turn, or as a new turn when idle', { timeout: 60_000 }, async () => {
  const idleIds: string[] = [], idle = await headless('rpc', { flag: 'work', connect: 'off', realTools: true, script: shellScript('idle', idleIds) });
  try {
    await idle.ask('shell probe idle');
    const marker = `[shell ${idleIds[0]}] `;
    await until(() => idle.turns.some(turn => turn.includes(marker)));
    const reported = idle.turns.filter(turn => turn.includes(marker));
    assert.equal(reported.length, 1, 'the report starts one model turn');
    assert.equal(reported[0].split(marker).length - 1, 1, 'and appears once in it');
    assert.match(reported[0], /\[shell [^\]]+\] completed · exit 0 · ran /);
    assert.match(reported[0], /idle-done/, 'with the last output of the shell');
    assert.deepEqual(idle.errors, []);
  } finally { await idle.close(); }

  const midIds: string[] = [], mid = await headless('rpc', { flag: 'work', connect: 'off', realTools: true, script: shellScript('mid', midIds) });
  try {
    await mid.ask('shell probe mid');
    const marker = `[shell ${midIds[0]}] `;
    // shell_start, then a foreground bash call that outlasts the shell: the report must join the same turn, before the reply.
    assert.equal(mid.turns.length, 3, 'no extra model turn: the report was steered between the tool calls');
    assert.equal(mid.turns[2].split(marker).length - 1, 1, 'once, in the request after the bash result');
    assert.match(mid.turns[2], /mid-done/);
    assert.deepEqual(mid.errors, []);
  } finally { await mid.close(); }
});

test('a shell stopped with shell_stop reports the stop once, not as a failure', { timeout: 60_000 }, async () => {
  const ids: string[] = [], pi = await headless('rpc', { flag: 'work', connect: 'off', realTools: true, script: shellScript('stop', ids) });
  try {
    await pi.ask('shell probe stop');
    const marker = `[shell ${ids[0]}] `;
    await until(() => pi.turns.some(turn => turn.includes(marker)));
    const reported = pi.turns.filter(turn => turn.includes(marker));
    assert.equal(reported.length, 1, 'the stop is reported in one model request');
    assert.equal(reported[0].split(marker).length - 1, 1, 'once');
    assert.match(reported[0], /\[shell [^\]]+\] stopped · ran /);
    assert.deepEqual(pi.errors, []);
  } finally { await pi.close(); }
});

/** Runs a probe prompt's scripted calls: the first starts a shell, each later one is made once the previous result is back, with the shell's ID. */
function probeSteps(probe: string, start: ScriptedCall, steps: ((id: string) => ScriptedCall)[], ids: string[]) {
  let results = 0;
  return (messages: Context['messages']): ScriptedCall | undefined => {
    const last = messages.at(-1), text = last ? textContent(last.content) : '';
    if (last?.role === 'user' && text.endsWith(`shell probe ${probe}`)) { results = 0; return start; }
    if (last?.role !== 'toolResult') return undefined;
    if (results++ === 0) ids.push(text.match(/Background shell (\S+) started/)?.[1] ?? '');
    return steps[results - 1]?.(ids[0]);
  };
}
const quick = `node -e "setTimeout(() => console.log('quiet-done'), 500)"`;
const sleep = `node -e "setTimeout(() => {}, 2500)"`;
const bash = (command: string): ScriptedCall => ({ name: 'bash', arguments: { command } });
const stop = (id: string): ScriptedCall => ({ name: 'shell_stop', arguments: { id } });

test('notify failure: a shell that fails is reported once; one that completes or is stopped is not', { timeout: 90_000 }, async () => {
  const failIds: string[] = [], failing = await headless('rpc', { flag: 'work', connect: 'off', realTools: true,
    script: probeSteps('failure', { name: 'shell_start', arguments: { command: `node -e "console.log('fail-out'); process.exit(3)"`, notify: 'failure' } }, [], failIds) });
  try {
    await failing.ask('shell probe failure');
    const marker = `[shell ${failIds[0]}] `;
    await until(() => failing.turns.some(turn => turn.includes(marker)));
    const reported = failing.turns.filter(turn => turn.includes(marker));
    assert.equal(reported.length, 1, 'the failure is reported in one model request');
    assert.match(reported[0], /\[shell [^\]]+\] failed · exit 3 · ran /);
    assert.match(reported[0], /fail-out/);
    assert.deepEqual(failing.errors, []);
  } finally { await failing.close(); }

  const doneIds: string[] = [], completed = await headless('rpc', { flag: 'work', connect: 'off', realTools: true,
    script: probeSteps('quiet', { name: 'shell_start', arguments: { command: quick, notify: 'failure' } }, [() => bash(sleep)], doneIds) });
  try {
    await completed.ask('shell probe quiet');
    assert.equal(completed.turns.length, 3, 'shell_start, then the bash call that outlasts the shell: no report request');
    assert.ok(!completed.turns.some(turn => turn.includes(`[shell ${doneIds[0]}] `)));
  } finally { await completed.close(); }

  const stopIds: string[] = [], stopped = await headless('rpc', { flag: 'work', connect: 'off', realTools: true,
    script: probeSteps('stopped', { name: 'shell_start', arguments: { command: `node -e "setInterval(() => {}, 1000)"`, notify: 'failure' } }, [() => bash(sleep), stop], stopIds) });
  try {
    await stopped.ask('shell probe stopped');
    assert.equal(stopped.turns.length, 4, 'shell_start, a bash call while the shell runs, shell_stop: no report request');
    assert.ok(!stopped.turns.some(turn => turn.includes(`[shell ${stopIds[0]}] `)));
  } finally { await stopped.close(); }
});

test("the profile's shell notice default applies to a shell_start that sets no notify", { timeout: 90_000 }, async () => {
  const ids: string[] = [], pi = await headless('rpc', { flag: 'failures', connect: 'off', realTools: true,
    script: probeSteps('default', { name: 'shell_start', arguments: { command: quick } }, [() => bash(sleep)], ids) });
  try {
    await pi.ask('shell probe default');
    assert.equal(pi.turns.length, 3, 'a completed shell is silent under the failures default');
    assert.ok(!pi.turns.some(turn => turn.includes(`[shell ${ids[0]}] `)));
  } finally { await pi.close(); }
});

test('an alert sends the matching line with the line before it, once; notify none keeps the end silent', { timeout: 60_000 }, async () => {
  const ids: string[] = [], pi = await headless('rpc', { flag: 'work', connect: 'off', realTools: true,
    script: probeSteps('alert', { name: 'shell_start', arguments: { command: `node -e "console.log('row 1'); console.log('row 2 MATCH'); console.log('row 3')"`, alert: 'MATCH', notify: 'none' } }, [], ids) });
  try {
    await pi.ask('shell probe alert');
    const marker = `[shell ${ids[0]}] alert: `;
    await until(() => pi.turns.some(turn => turn.includes(marker)));
    const alerted = pi.turns.filter(turn => turn.includes(marker));
    assert.equal(alerted.length, 1, 'one alert, in one model request');
    assert.match(alerted[0], /alert: \/MATCH\/ · 1 new match on line 2 · 1 so far/);
    assert.match(alerted[0], /  1 \| row 1/, 'with the line before the match');
    assert.match(alerted[0], /> 2 \| row 2 MATCH/);
    assert.deepEqual(pi.errors, []);
  } finally { await pi.close(); }
});
