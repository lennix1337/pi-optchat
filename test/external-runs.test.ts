import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ModelRegistry, ModelRuntime, SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { TuiMainScreen, type Terminal } from '@earendil-works/pi-tui';
import { ExternalRuns, SubagentRpc, asyncStatusToRuns, foregroundHistoryToRuns, liveForegroundToRun, parseSessionHeader, piSubagentsPaths, resolveTempScopeId, type SubagentEvents } from '../src/external-runs.ts';
import { orderRuns } from '../src/runs.ts';
import { requestInterrupt, requestSteer, requestStop, steerRequestsDir, stopRequestsDir } from '../src/external-control.ts';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { Inspector } from '../src/inspector.ts';
import { AgentView } from '../src/agent-view.ts';
import { UsageLedger, emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

class OffscreenTerminal implements Terminal {
  start() {} stop() {} async drainInput() {} write(_data: string) {}
  get columns() { return 100; } get rows() { return 30; } get kittyProtocolActive() { return false; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const plain = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;:]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(\x07|\x1b\\)/g, '');
initTheme('dark', false);

const status = (over: Record<string, unknown> = {}) => ({
  lifecycleArtifactVersion: 3, runId: 'run-a', sessionId: 'session-1', mode: 'single', state: 'complete',
  startedAt: 100, endedAt: 400, cwd: 'C:\\work', lastUpdate: 400,
  steps: [{ agent: 'worker', sessionName: 'worker: reply with exactly ok', model: 'anthropic/claude-haiku-5-5', thinking: 'low', sessionFile: 'C:\\work\\session.jsonl' }],
  ...over,
});

function writeRun(root: string, id: string, value: unknown) {
  const dir = join(root, 'async-subagent-runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

function writeHistory(root: string, value: unknown) {
  const dir = join(root, 'async-subagent-results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'foreground-history.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

function writeLive(root: string, name: string, value: unknown) {
  const dir = join(root, 'async-subagent-results', 'live-foreground');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

test('the temp scope mirrors pi-subagents, so both extensions find the same artifacts', () => {
  assert.equal(resolveTempScopeId({ env: { USERNAME: 'ada lovelace' }, getuid: undefined }), 'user-ada-lovelace');
  assert.equal(resolveTempScopeId({ env: { LOGNAME: 'ada' }, getuid: undefined }), 'user-ada');
  assert.equal(resolveTempScopeId({ env: {}, getuid: () => 42 }), 'uid-42');
  assert.equal(resolveTempScopeId({ env: { USERPROFILE: 'C:\\Users\\ada' }, getuid: undefined, userInfo: () => ({ username: null }) }), 'home-C-Users-ada');
  assert.equal(resolveTempScopeId({ env: {}, getuid: undefined, userInfo: () => { throw new Error('no user'); }, homedir: () => '' }), 'shared');
  const root = join(tmpdir(), 'pi-subagents-root');
  assert.equal(piSubagentsPaths({ env: { PI_SUBAGENTS_TEMP_ROOT: root }, getuid: undefined }).root, resolve(root));
  assert.equal(piSubagentsPaths({ env: { PI_SUBAGENTS_TEMP_ROOT: root }, getuid: undefined }).asyncDir, join(resolve(root), 'async-subagent-runs'));
});

test('an async status becomes a panel row with the real model, thinking level and agent', () => {
  const [run] = asyncStatusToRuns(status());
  assert.equal(run?.id, 'pi-run-a');
  assert.equal(run?.state, 'completed');
  assert.equal(run?.model, 'anthropic/claude-haiku-5-5');
  assert.equal(run?.thinking, 'low');
  assert.equal(run?.agent, 'worker');
  assert.equal(run?.task, 'worker: reply with exactly ok');
  assert.equal(run?.sessionFile, 'C:\\work\\session.jsonl');
  assert.equal(run?.source, 'pi-subagents');
  assert.equal(run?.externalKind, 'async');
  assert.equal(run?.externalRunId, 'run-a');
  assert.equal(run?.started, 100);
  assert.equal(run?.ended, 400);
  assert.equal(run?.durationUnknown, undefined);
  // A running status has no end time yet, and a status without a start time cannot be placed in the list.
  assert.equal(asyncStatusToRuns(status({ state: 'running', endedAt: undefined }))[0]?.ended, undefined);
  assert.deepEqual(asyncStatusToRuns({ runId: 'x', state: 'running' }), []);
  assert.deepEqual(asyncStatusToRuns({ runId: 'x', state: 'mystery' }), []);
  assert.deepEqual(asyncStatusToRuns('not an object'), []);
  // A model written with its thinking suffix shows both parts from the first frame.
  const [early] = asyncStatusToRuns({ runId: 'y', state: 'running', startedAt: 10, model: 'anthropic/claude-haiku-5-5:low' });
  assert.equal(early?.model, 'anthropic/claude-haiku-5-5');
  assert.equal(early?.thinking, 'low');
  // A model id that merely contains a colon is left alone.
  const [colon] = asyncStatusToRuns({ runId: 'z', state: 'running', startedAt: 10, model: 'openrouter:some/model' });
  assert.equal(colon?.model, 'openrouter:some/model');
  assert.equal(colon?.thinking, 'unknown');
});

test('a multi-step run shows one row per step, each with its own model, thinking level and state', () => {
  const rows = asyncStatusToRuns({ runId: 'wf', state: 'running', startedAt: 100, cwd: 'C:\\work', sessionId: 's1', steps: [
    { agent: 'scout', sessionName: 'scout: look around', model: 'anthropic/claude-haiku-5-5', thinking: 'low', status: 'complete', startedAt: 100, endedAt: 200, sessionFile: 'C:\\work\\a.jsonl' },
    { agent: 'worker', sessionName: 'worker: build it', model: 'openai-codex/gpt-6.1-sol', thinking: 'high', status: 'running', startedAt: 200, sessionFile: 'C:\\work\\b.jsonl' },
    { agent: 'reviewer', label: 'review', model: 'anthropic/claude-opus-5-5', thinking: 'off', status: 'pending' },
  ] });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.id), ['pi-wf-0', 'pi-wf-1', 'pi-wf-2']);
  assert.deepEqual(rows.map(row => row.state), ['completed', 'running', 'waiting']);
  assert.deepEqual(rows.map(row => row.model), ['anthropic/claude-haiku-5-5', 'openai-codex/gpt-6.1-sol', 'anthropic/claude-opus-5-5']);
  assert.deepEqual(rows.map(row => row.thinking), ['low', 'high', 'off']);
  assert.deepEqual(rows.map(row => row.agent), ['scout', 'worker', 'reviewer']);
  // The runner counts steps by position, so the control target is the step's place in the list.
  assert.deepEqual(rows.map(row => row.externalStepIndex), [0, 1, 2]);
  assert.equal(rows[0].ended, 200);
  assert.equal(rows[1].ended, undefined);
});

test('the foreground history becomes one row per saved child, without a fabricated duration', () => {
  const runs = foregroundHistoryToRuns({ version: 1, runs: [{ runId: 'r1', cwd: 'C:\\work', sessionId: 'session-1', updatedAt: 500, mode: 'single',
    children: [{ agent: 'delegate', index: 0, sessionName: 'delegate: what is the codeword', status: 'completed', model: 'openai-codex/gpt-6.1-sol', sessionFile: 'C:\\work\\s.jsonl' }] }] });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, 'pi-r1-0');
  assert.equal(runs[0].state, 'completed');
  assert.equal(runs[0].model, 'openai-codex/gpt-6.1-sol');
  assert.equal(runs[0].thinking, 'unknown');
  assert.equal(runs[0].agent, 'delegate');
  assert.equal(runs[0].durationUnknown, true);
  assert.equal(runs[0].externalKind, 'foreground');
  assert.equal(foregroundHistoryToRuns({ version: 2, runs: [] }).length, 0);
  assert.equal(foregroundHistoryToRuns(null).length, 0);
});

test('external runs are read from disk, and hiding one keeps it out of the panel for good', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-subagents-root-')), profile = mkdtempSync(join(tmpdir(), 'optchat-profile-'));
  try {
    writeRun(root, 'run-a', status());
    writeRun(root, 'run-b', '{ not json');
    writeHistory(root, { version: 1, runs: [{ runId: 'r1', cwd: 'C:\\work', updatedAt: 500, children: [{ agent: 'delegate', index: 0, status: 'completed', model: 'x/y' }] }] });
    const runs = new ExternalRuns(profile, { root, throttleMs: 0 });
    runs.refresh(true);
    assert.deepEqual([...runs.records.keys()].sort(), ['pi-r1-0', 'pi-run-a']);
    assert.equal(runs.get('pi-run-a')?.model, 'anthropic/claude-haiku-5-5');
    assert.deepEqual(runs.controlTarget('pi-run-a'), { runId: 'run-a', dir: join(root, 'async-subagent-runs', 'run-a') });
    assert.equal(runs.controlTarget('pi-r1-0'), undefined, 'finished foreground runs are not controllable');
    assert.equal(runs.activeCount(), 0);
    assert.equal(runs.hide('pi-run-a'), true);
    assert.equal(runs.get('pi-run-a'), undefined);
    // A new panel instance in the same profile keeps the run hidden.
    const again = new ExternalRuns(profile, { root, throttleMs: 0 });
    again.refresh(true);
    assert.equal(again.get('pi-run-a'), undefined);
    assert.equal(again.get('pi-r1-0')?.id, 'pi-r1-0');
  } finally { removeDir(root); removeDir(profile); }
});

test('a pi-subagents run whose runner is gone shows as interrupted, not running, without touching its files', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-subagents-root-')), profile = mkdtempSync(join(tmpdir(), 'optchat-profile-'));
  try {
    const minute = 60_000, now = 100 * minute;
    const running = (runId: string, over: Record<string, unknown>) => status({ runId, state: 'running', endedAt: undefined, startedAt: minute, lastUpdate: now - 5 * minute, ...over });
    writeRun(root, 'dead', running('dead', { pid: 11 }));
    writeRun(root, 'alive', running('alive', { pid: 22 }));
    writeRun(root, 'just-written', running('just-written', { pid: 33, lastUpdate: now - 1000 }));
    // A recycled PID still answers, but the runner would have written its timeout result long ago.
    writeRun(root, 'overdue', running('overdue', { pid: 44, timeoutMs: 30 * minute, deadlineAt: now - 20 * minute, lastUpdate: now - 15 * minute }));
    writeRun(root, 'no-pid', running('no-pid', {}));
    const alive = new Set([22, 44]);
    const runs = new ExternalRuns(profile, { root, throttleMs: 0, now: () => now, processAlive: pid => alive.has(pid) });
    runs.refresh(true);
    assert.equal(runs.get('pi-dead')?.state, 'interrupted');
    assert.equal(runs.get('pi-dead')?.ended, now - 5 * minute, 'ended when the runner last wrote');
    assert.equal(runs.get('pi-alive')?.state, 'running');
    assert.equal(runs.get('pi-just-written')?.state, 'running', 'a fresh status gets a grace period');
    assert.equal(runs.get('pi-overdue')?.state, 'interrupted');
    assert.equal(runs.get('pi-no-pid')?.state, 'running', 'no PID is no evidence');
    assert.equal(runs.activeCount(), 3);
    // The runner dies after the status was cached: the next refresh notices without the file changing.
    alive.delete(22);
    runs.refresh(true);
    assert.equal(runs.get('pi-alive')?.state, 'interrupted');
    assert.equal(JSON.parse(readFileSync(join(root, 'async-subagent-runs', 'dead', 'status.json'), 'utf8')).state, 'running', 'pi-subagents files stay read-only');
  } finally { removeDir(root); removeDir(profile); }
});

test('a running pi-subagents run is active, and a corrupt status file is skipped instead of breaking the panel', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-subagents-root-')), profile = mkdtempSync(join(tmpdir(), 'optchat-profile-'));
  try {
    writeRun(root, 'live', status({ runId: 'live', state: 'running', endedAt: undefined, startedAt: 100, lastUpdate: 100 }));
    writeRun(root, 'broken', 'not json at all');
    const runs = new ExternalRuns(profile, { root, throttleMs: 0 });
    runs.refresh(true);
    assert.equal(runs.get('pi-live')?.state, 'running');
    assert.equal(runs.get('pi-live')?.ended, undefined);
    assert.equal(runs.activeCount(), 1);
    assert.equal(runs.get('pi-broken'), undefined);
    assert.deepEqual(runs.warnings, []);
  } finally { removeDir(root); removeDir(profile); }
});

test('a saved run with no thinking level gets the one its own session file records', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-subagents-root-')), profile = mkdtempSync(join(tmpdir(), 'optchat-profile-'));
  try {
    const session = join(root, 'session.jsonl');
    writeFileSync(session, ['{"type":"session","version":3,"id":"s"}',
      '{"type":"model_change","provider":"anthropic","modelId":"claude-opus-5-5"}',
      '{"type":"thinking_level_change","thinkingLevel":"max"}', ''].join('\n'));
    assert.deepEqual(parseSessionHeader(readFileSync(session, 'utf8')), { model: 'anthropic/claude-opus-5-5', thinking: 'max' });
    writeHistory(root, { version: 1, runs: [{ runId: 'r1', cwd: 'C:\\work', updatedAt: 500, children: [{ agent: 'delegate', index: 0, status: 'completed', model: 'anthropic/claude-opus-5-5', sessionFile: session }] }] });
    const runs = new ExternalRuns(profile, { root, throttleMs: 0 });
    runs.refresh(true);
    assert.equal(runs.get('pi-r1-0')?.thinking, 'max');
    assert.equal(runs.get('pi-r1-0')?.model, 'anthropic/claude-opus-5-5');
  } finally { removeDir(root); removeDir(profile); }
});

test('a running foreground child shows in the panel, and its saved history keeps the real start time', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-subagents-root-')), profile = mkdtempSync(join(tmpdir(), 'optchat-profile-'));
  try {
    writeLive(root, 'r1-0.json', { version: 1, runId: 'r1', index: 0, agent: 'delegate', task: 'do the thing', cwd: 'C:\\work',
      sessionId: 'session-1', model: 'anthropic/claude-haiku-5-5:low', startedAt: 100, updatedAt: 200, state: 'running' });
    const runs = new ExternalRuns(profile, { root, throttleMs: 0, now: () => 300 });
    runs.refresh(true);
    const live = runs.get('pi-r1-0');
    assert.equal(live?.state, 'running');
    assert.equal(live?.externalKind, 'live-foreground');
    assert.equal(live?.model, 'anthropic/claude-haiku-5-5');
    assert.equal(live?.thinking, 'low');
    assert.equal(live?.agent, 'delegate');
    assert.equal(live?.started, 100);
    assert.equal(live?.ended, undefined);
    // The saved history replaces the live row and keeps the start time the live record knew.
    rmSync(join(root, 'async-subagent-results', 'live-foreground', 'r1-0.json'));
    writeHistory(root, { version: 1, runs: [{ runId: 'r1', cwd: 'C:\\work', updatedAt: 500, children: [{ agent: 'delegate', index: 0, status: 'completed', model: 'anthropic/claude-haiku-5-5' }] }] });
    runs.refresh(true);
    const done = runs.get('pi-r1-0');
    assert.equal(done?.state, 'completed');
    assert.equal(done?.started, 100);
    assert.equal(done?.ended, 500);
    assert.equal(done?.durationUnknown, false);
  } finally { removeDir(root); removeDir(profile); }
});

test('a live record whose heartbeat stopped is ignored, because that run died without cleaning up', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-subagents-root-')), profile = mkdtempSync(join(tmpdir(), 'optchat-profile-'));
  try {
    writeLive(root, 'r1-0.json', { version: 1, runId: 'r1', index: 0, agent: 'delegate', task: 'do the thing', cwd: 'C:\\work', startedAt: 100, updatedAt: 200, state: 'running' });
    const stale = new ExternalRuns(profile, { root, throttleMs: 0, now: () => 60 * 60 * 1000 });
    stale.refresh(true);
    assert.equal(stale.get('pi-r1-0'), undefined);
    const fresh = new ExternalRuns(profile, { root, throttleMs: 0, now: () => 400 });
    fresh.refresh(true);
    assert.equal(fresh.get('pi-r1-0')?.state, 'running');
  } finally { removeDir(root); removeDir(profile); }
});

test('the control inbox carries a stop, a steer and an interrupt request to the runner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-subagents-run-'));
  try {
    const stopFile = requestStop(dir, { source: 'pi-optchat', reason: 'Stopped from OptChat' });
    const stop = JSON.parse(readFileSync(stopFile, 'utf8'));
    assert.equal(stop.type, 'stop');
    assert.equal(stop.source, 'pi-optchat');
    assert.equal(stop.targetIndex, undefined);
    assert.ok(stopFile.startsWith(stopRequestsDir(dir)), 'the runner watches this directory');
    const steerFile = requestSteer(dir, 'go on', { source: 'pi-optchat', mode: 'steer', stepIndex: 2 });
    const steer = JSON.parse(readFileSync(steerFile, 'utf8'));
    assert.equal(steer.type, 'steer');
    assert.equal(steer.message, 'go on');
    assert.equal(steer.mode, 'steer');
    assert.equal(steer.targetIndex, 2);
    assert.ok(!/\s/.test(steer.id), 'the runner requires an id without whitespace');
    assert.ok(steerFile.startsWith(steerRequestsDir(dir)));
    assert.equal(JSON.parse(readFileSync(requestInterrupt(dir, { source: 'pi-optchat' }), 'utf8')).type, 'interrupt');
    assert.throws(() => requestSteer(dir, '   '), /cannot be empty/);
    // A runner that closed its inbox says so instead of dropping the request.
    mkdirSync(join(dir, 'control'), { recursive: true });
    writeFileSync(join(dir, 'control', 'stop-inbox-closed.json'), JSON.stringify({ version: 1, closedAt: 1 }));
    assert.throws(() => requestStop(dir), /closed its stop inbox/);
  } finally { removeDir(dir); }
});

test('the merged list puts live runs first and keeps a parent next to its children', () => {
  const native = (id: string, started: number, parentId?: string, state: 'running' | 'completed' = 'completed') =>
    ({ id, task: id, cwd: '.', model: 'test/model', thinking: 'off', parentSession: '', started, depth: parentId ? 2 : 1, ...(parentId ? { parentId } : {}), state, guidance: [] });
  const ordered = orderRuns([native('parent', 10), native('child', 20, 'parent'), { ...native('live', 5, undefined, 'running'), id: 'pi-live', source: 'pi-subagents' as const }]);
  assert.deepEqual(ordered.map(run => run.id), ['pi-live', 'parent', 'child']);
  // An id that a native run already uses stays with the native run.
  const clash = orderRuns([native('pi-same', 10), { ...native('pi-same', 5, undefined, 'running'), source: 'pi-subagents' as const }]);
  assert.equal(clash.length, 1);
  assert.equal(clash[0].source, undefined);
});

test('the pi-subagents RPC answers are correlated per request, and a missing peer is reported', async () => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const events: SubagentEvents = {
    emit: (channel, data) => { for (const handler of handlers.get(channel) ?? []) handler(data); },
    on: (channel, handler) => {
      const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
      set.add(handler);
      handlers.set(channel, set);
      return () => { set.delete(handler); };
    },
  };
  const requests: any[] = [];
  let reply = (request: any) => { events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { state: 'stopping' } }); };
  events.on('subagents:rpc:v1:request', request => {
    requests.push(request);
    reply(request);
  });
  const rpc = new SubagentRpc(events, 1000);
  assert.deepEqual(await rpc.call('stop', { id: 'run-a' }), { state: 'stopping' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].version, 1);
  assert.equal(requests[0].method, 'stop');
  assert.deepEqual(requests[0].params, { id: 'run-a' });
  assert.equal(requests[0].source.extension, 'pi-optchat');
  // An error reply is an error, not a silent no-op.
  reply = request => { events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: false, error: { code: 'not_found', message: 'No such run in this session.' } }); };
  await assert.rejects(() => rpc.call('steer', { id: 'run-a', message: 'hi' }), /No such run in this session/);
  // Without a peer the call says so instead of hanging.
  // The RPC timer is unref'd so it never keeps Pi alive; hold the loop open here or Node 22 ends the file before it fires.
  const silent = new SubagentRpc({ emit: () => {}, on: () => () => {} }, 20);
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(() => silent.call('stop', { id: 'run-a' }), /did not answer stop/); } finally { clearInterval(keepAlive); }
  await assert.rejects(() => new SubagentRpc(undefined).call('stop', {}), /no extension event bus/);
});

test('the agents panel lists pi-subagents runs with their own model, and d hides a finished one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-subagents-root-')), dir = mkdtempSync(join(tmpdir(), 'optchat-panel-'));
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  try {
    writeRun(root, 'run-a', status());
    const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
    const inspector = new Inspector({ profile: 'personal', session: 'parent', children, usage: new UsageLedger(dir), memory, page: 'agents', rows: () => 24, redraw: () => {}, done: () => {}, color: (_tone, text) => text, context: () => undefined });
    try {
      const screen = inspector.render(100).join('\n');
      assert.match(screen, /π worker: reply with exactly ok/);
      assert.match(screen, /claude-haiku-5-5\(low\)/);
      assert.match(screen, /1 π/);
      inspector.handleInput('d');
      assert.match(inspector.render(100).at(-2) ?? '', /Press d again to hide this π run from the panel/);
      inspector.handleInput('d');
      assert.match(inspector.render(100).at(-2) ?? '', /Hidden from this panel; pi-subagents keeps the run/);
      assert.doesNotMatch(inspector.render(100).join('\n'), /claude-haiku-5-5/);
      assert.equal(children.external.isHidden('pi-run-a'), true);
    } finally { inspector.dispose(); await children.close(); await memory.close(); removeDir(dir); }
  } finally { if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = previous; removeDir(root); }
});

test('a live pi-subagents run is steered and stopped through the runner control inbox, not through OptChat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-subagents-root-')), dir = mkdtempSync(join(tmpdir(), 'optchat-view-'));
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  try {
    const session = SessionManager.create(dir, join(dir, 'runs'));
    session.appendMessage({ role: 'user', content: 'Your task:\nKeep working', timestamp: 1 });
    writeRun(root, 'run-a', status({ state: 'running', endedAt: undefined, lastUpdate: 100, steps: [{ agent: 'worker', sessionName: 'worker: keep working', model: 'anthropic/claude-haiku-5-5', thinking: 'low', sessionFile: session.getSessionFile() }] }));
    const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
    const tui = new TuiMainScreen(new OffscreenTerminal());
    const view = new AgentView({ id: 'pi-run-a', children, tui, rows: () => 30, redraw: () => {}, done: () => {}, color: (_tone, text) => text });
    const runDir = join(root, 'async-subagent-runs', 'run-a');
    try {
      const text = () => plain(view.render(100));
      assert.match(text(), /Ctrl\+X stop/);
      assert.match(text(), /Ctrl\+C interrupt/);
      for (const key of 'Go on.') view.handleInput(key);
      view.handleInput('\r');
      await new Promise(r => setTimeout(r, 20));
      const steers = readdirSync(steerRequestsDir(runDir)).map(file => JSON.parse(readFileSync(join(steerRequestsDir(runDir), file), 'utf8')));
      assert.equal(steers.length, 1);
      assert.equal(steers[0].type, 'steer');
      assert.equal(steers[0].message, 'Go on.');
      assert.match(text(), /Message sent to pi-subagents/);
      view.handleInput('\x18');
      assert.match(text(), /Press Ctrl\+X again to stop this pi-subagents run/);
      view.handleInput('\x18');
      await new Promise(r => setTimeout(r, 20));
      const stops = readdirSync(stopRequestsDir(runDir)).map(file => JSON.parse(readFileSync(join(stopRequestsDir(runDir), file), 'utf8')));
      assert.equal(stops.length, 1);
      assert.equal(stops[0].type, 'stop');
      // OptChat's own agent control never touches a run that belongs to pi-subagents.
      await assert.rejects(() => children.tell('pi-run-a', 'from the main agent', 'manager'), /only the user can steer it/);
    } finally { view.dispose(); await children.close(); await memory.close(); removeDir(dir); }
  } finally { if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = previous; removeDir(root); }
});

test('a live foreground child is steered through pi-subagents itself', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-subagents-root-')), dir = mkdtempSync(join(tmpdir(), 'optchat-view-'));
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  try {
    const session = SessionManager.create(dir, join(dir, 'runs'));
    session.appendMessage({ role: 'user', content: 'Your task:\nKeep working', timestamp: 1 });
    writeLive(root, 'r1-0.json', { version: 1, runId: 'r1', index: 0, agent: 'delegate', task: 'keep working', cwd: dir,
      sessionId: 'session-1', model: 'anthropic/claude-haiku-5-5:low', startedAt: 100, updatedAt: Date.now(), state: 'running', sessionFile: session.getSessionFile() });
    const handlers = new Map<string, Set<(data: unknown) => void>>();
    const requests: any[] = [];
    const events: SubagentEvents = {
      emit: (channel, data) => { for (const handler of handlers.get(channel) ?? []) handler(data); },
      on: (channel, handler) => {
        const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
        set.add(handler);
        handlers.set(channel, set);
        return () => { set.delete(handler); };
      },
    };
    events.on('subagents:rpc:v1:request', (request: any) => {
      requests.push(request);
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { state: 'paused' } });
    });
    const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir, { events });
    const tui = new TuiMainScreen(new OffscreenTerminal());
    const view = new AgentView({ id: 'pi-r1-0', children, tui, rows: () => 30, redraw: () => {}, done: () => {}, color: (_tone, text) => text });
    try {
      const text = () => plain(view.render(100));
      assert.match(text(), /Ctrl\+X pause/, 'a foreground child can be paused, not stopped');
      for (const key of 'Go on.') view.handleInput(key);
      view.handleInput('\r');
      await new Promise(r => setTimeout(r, 20));
      assert.equal(requests[0]?.method, 'steer');
      assert.deepEqual(requests[0]?.params, { id: 'r1', message: 'Go on.', mode: 'steer' });
      assert.match(text(), /Message sent to pi-subagents/);
    } finally { view.dispose(); await children.close(); await memory.close(); removeDir(dir); }
  } finally { if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = previous; removeDir(root); }
});

test('a pi-subagents transcript opens read-only, with the run own model and thinking level', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-subagents-root-')), dir = mkdtempSync(join(tmpdir(), 'optchat-view-'));
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  try {
    const session = SessionManager.create(dir, join(dir, 'runs'));
    session.appendMessage({ role: 'user', content: 'Your task:\nReply with exactly ok', timestamp: 1 });
    session.appendMessage({ role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-haiku-5-5', usage: emptyUsage(), stopReason: 'stop', timestamp: 2, content: [{ type: 'text', text: 'ok' }] });
    writeRun(root, 'run-a', status({ steps: [{ agent: 'worker', sessionName: 'worker: reply with exactly ok', model: 'anthropic/claude-haiku-5-5', thinking: 'low', sessionFile: session.getSessionFile() }] }));
    const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
    const tui = new TuiMainScreen(new OffscreenTerminal());
    const view = new AgentView({ id: 'pi-run-a', children, tui, rows: () => 30, redraw: () => {}, done: () => {}, color: (_tone, text) => text });
    try {
      const lines = view.render(100), text = plain(lines);
      assert.match(lines[0], /pi-run-a {2}worker: reply with exactly ok .*completed .*claude-haiku-5-5\(low\).*π/);
      assert.match(text, /ok/, 'the saved transcript is readable');
      assert.match(text, /Read-only pi-subagents transcript/);
      assert.doesNotMatch(text, /Ctrl\+X stop/, 'a finished run cannot be stopped');
    } finally { view.dispose(); await children.close(); await memory.close(); removeDir(dir); }
  } finally { if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = previous; removeDir(root); }
});
