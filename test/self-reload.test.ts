import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { GOAL_HOLD, HOLD_MAX_MS, registerSelfReload, RELOAD_ENTRY } from '../src/self-reload.ts';

function fixture() {
  const entries: any[] = [], notices: string[] = [], sent: any[] = [], commands = new Map<string, any>(), hooks = new Map<string, any[]>();
  let busy: string | undefined, reloads = 0, prepares = 0;
  let tools: any[] = [], responder: ((data: any) => void) | undefined;
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  let replacement: string | undefined;
  const ctx = { cwd: 'fixture-cwd', mode: 'tui', isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'session-1', getBranch: () => entries },
    ui: { notify: (message: string) => notices.push(message) }, reload: async () => { reloads++; } } as unknown as ExtensionContext;
  const pi = { on: (name: string, hook: any) => { hooks.set(name, [...hooks.get(name) ?? [], hook]); return () => {}; },
    registerCommand: (name: string, command: any) => commands.set(name, command), registerTool: (tool: any) => { toolDef = tool; },
    getAllTools: () => tools,
    events: {
      emit(name: string, data: any) { if (name === 'optchat:reload-check') responder?.(data); for (const fn of listeners.get(name) ?? []) fn(data); },
      on(name: string, fn: (data: unknown) => void) { listeners.set(name, [...listeners.get(name) ?? [], fn]); return () => listeners.set(name, (listeners.get(name) ?? []).filter(f => f !== fn)); },
    },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data: structuredClone(data) }),
    sendUserMessage: (...args: any[]) => sent.push(['command', ...args]), sendMessage: (...args: any[]) => sent.push(['message', ...args]) } as unknown as ExtensionAPI;
  let toolDef: any;
  const attach = () => { hooks.clear(); registerSelfReload(pi, () => ({ profile: 'fixture', blocked: busy }), async () => { prepares++; }); };
  const emit = async (name: string, event: any = {}) => { for (const hook of hooks.get(name) ?? []) await hook(event, ctx); await new Promise(resolve => setImmediate(resolve)); };
  attach();
  (ctx as any).reload = async () => {
    reloads++; await emit('session_shutdown', { reason: 'reload' }); attach();
    if (replacement === 'cwd') (ctx as any).cwd = 'elsewhere';
    if (replacement === 'session') (ctx.sessionManager as any).getSessionId = () => 'session-2';
    await emit('session_start', { reason: replacement === 'restart' ? 'startup' : 'reload' });
  };
  const goalHeld = () => { let reason: string | undefined; pi.events.emit(GOAL_HOLD, { hold: (why: string) => { reason ??= why; } }); return reason; };
  return { ctx, pi, entries, notices, sent, commands, emit, attach, goalHeld, tool: () => toolDef,
    request: () => toolDef.execute('call-1', { checkpoint: 'Verified A. Next inspect B; do not repeat A.' }, new AbortController().signal, undefined, ctx),
    busy: (reason?: string) => { busy = reason; }, reloads: () => reloads, prepares: () => prepares,
    latest: () => entries.filter(e => e.customType === RELOAD_ENTRY).at(-1)?.data,
    replacement: (kind: string) => { replacement = kind; },
    delegation: (answer?: string | false) => { tools = [{ name: 'subagent' }]; responder = answer === false ? undefined : data => data.respond('pi-subagents', answer); } };
}

test('checkpoint precedes terminal reload; fresh runtime sends one custom continuation', async () => {
  const f = fixture();
  assert.equal((await f.request()).isError, undefined);
  assert.equal(f.latest().state, 'requested'); assert.equal(f.reloads(), 0);
  await f.emit('agent_settled', { aborted: false });
  const command = f.sent[0]; assert.equal(command[0], 'command'); assert.equal(command[2].expandPromptTemplates, true);
  const [name, token] = command[1].slice(1).split(' ');
  await f.commands.get(name).handler(token, f.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.prepares(), 1); assert.equal(f.reloads(), 1); assert.equal(f.latest().state, 'resuming');
  assert.equal(f.sent[1][0], 'message'); assert.equal(f.sent[1][1].customType, 'optchat-reload-resume');
  assert.match(f.sent[1][1].content, /Verified A/); assert.match(f.sent[1][1].content, /not.*authorization/i);
  await f.emit('session_start', { reason: 'reload' }); assert.equal(f.sent.length, 2);
  await f.emit('agent_settled', { aborted: false }); assert.equal(f.latest().state, 'resuming', 'unrelated settlement is not proof of continuation');
  await f.emit('before_agent_start', { messageType: 'custom', message: { customType: 'optchat-reload-resume' } });
  await f.emit('agent_settled', { aborted: false }); assert.equal(f.latest().state, 'completed');
});

for (const reason of ['active shells', 'active subagents', 'uncertain operation', 'profile closing']) test(`request blocked: ${reason}`, async () => {
  const f = fixture(); f.busy(reason);
  assert.equal((await f.request()).isError, true); assert.equal(f.entries.length, 0); assert.equal(f.reloads(), 0);
});

for (const abort of [false, true]) test(`recheck at settlement cancels instead of stopping work (abort=${abort})`, async () => {
  const f = fixture(); await f.request(); if (!abort) f.busy('new background job');
  await f.emit('agent_settled', { aborted: abort }); assert.equal(f.latest().state, 'cancelled'); assert.equal(f.sent.length, 0);
});

test('wrong internal token and manual reload cannot resume a request', async () => {
  const f = fixture(); await f.request();
  await assert.rejects(f.commands.values().next().value.handler('forged', f.ctx), /token/i);
  assert.equal(f.reloads(), 0); f.attach(); await f.emit('session_start', { reason: 'reload' });
  assert.equal(f.sent.length, 0); assert.equal(f.latest().state, 'cancelled');
});

test('crash, changed cwd or session never automatically replays reload or continuation', async () => {
  for (const kind of ['restart', 'cwd', 'session']) {
    const f = fixture(); await f.request(); await f.emit('agent_settled', { aborted: false });
    f.replacement(kind);
    const [name, token] = f.sent[0][1].slice(1).split(' '); await f.commands.get(name).handler(token, f.ctx);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sent.length, 1); assert.equal(f.reloads(), 1);
  }
});

test('a replacement cancels an interrupted claimed continuation instead of replaying or permanently blocking new requests', async () => {
  const f = fixture(); await f.request(); await f.emit('agent_settled', { aborted: false });
  const [name, token] = f.sent[0][1].slice(1).split(' '); await f.commands.get(name).handler(token, f.ctx);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.latest().state, 'resuming');
  const before = f.sent.length; f.attach(); await f.emit('session_start', { reason: 'startup' });
  assert.equal(f.latest().state, 'cancelled'); assert.equal(f.sent.length, before);
});

test('delegation readiness fails closed when missing or busy and accepts confirmed idle', async () => {
  for (const answer of [false, 'active subagent work', undefined] as const) {
    const f = fixture(); f.delegation(answer);
    assert.equal((await f.request()).isError, answer === undefined ? undefined : true);
    assert.equal(f.reloads(), 0);
  }
});

test('queued input, operator interruption and failed final response cancel automatic reload', async () => {
  for (const kind of ['queue', 'operator', 'error']) {
    const f = fixture(); await f.request();
    if (kind === 'queue') (f.ctx as any).hasPendingMessages = () => true;
    if (kind === 'operator') await f.emit('input', { source: 'interactive', text: 'Stop, new task.' });
    if (kind === 'error') f.entries.push({ type: 'message', message: { role: 'assistant', stopReason: 'error' } });
    await f.emit('agent_settled', { aborted: false });
    assert.equal(f.latest().state, 'cancelled'); assert.equal(f.sent.length, 0);
  }
});

test('fresh runtime waits for reload completion, and late reload failure never dispatches continuation', async () => {
  const f = fixture(); await f.request(); await f.emit('agent_settled', { aborted: false });
  let fail!: () => void;
  const result = new Promise<void>(resolve => { fail = resolve; });
  (f.ctx as any).reload = async () => { f.attach(); await f.emit('session_start', { reason: 'reload' }); await result; throw new Error('late resource load failure'); };
  const [name, token] = f.sent[0][1].slice(1).split(' ');
  const command = f.commands.get(name).handler(token, f.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1, 'session_start alone is not proof that resource reload succeeded');
  fail(); await command;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sent.length, 1);
});

test('a pending reload holds the goal checkpoint until its own continuation starts, then lets it go', async () => {
  const f = fixture();
  assert.equal(f.goalHeld(), undefined, 'no reload, no hold');
  await f.request(); assert.match(f.goalHeld() ?? '', /self-reload/);
  await f.emit('agent_settled', { aborted: false }); assert.ok(f.goalHeld(), 'still held while the reload command is queued');
  const [name, token] = f.sent[0][1].slice(1).split(' ');
  await f.commands.get(name).handler(token, f.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.latest().state, 'resuming'); assert.ok(f.goalHeld(), 'the fresh runtime holds the goal until the continuation runs');
  await f.emit('before_agent_start', { messageType: 'custom', message: { customType: 'optchat-reload-resume' } });
  assert.equal(f.goalHeld(), undefined, 'the continuation started: the goal may follow it');
});

test('a cancelled reload releases the goal, and a stuck one stops holding after HOLD_MAX_MS', async t => {
  const f = fixture(); await f.request();
  await f.emit('input', { source: 'interactive', text: 'new task' });
  assert.equal(f.latest().state, 'cancelled'); assert.equal(f.goalHeld(), undefined);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const g = fixture(); await g.request(); assert.ok(g.goalHeld());
  t.mock.timers.tick(HOLD_MAX_MS + 1); assert.equal(g.goalHeld(), undefined);
});

test('an automatic turn that takes the slot first defers the reload to the next settlement instead of cancelling it', async () => {
  const f = fixture(); await f.request(); await f.emit('agent_settled', { aborted: false });
  const [name, token] = f.sent[0][1].slice(1).split(' ');
  (f.ctx as any).isIdle = () => false;
  await f.commands.get(name).handler(token, f.ctx);
  assert.equal(f.latest().state, 'requested'); assert.equal(f.reloads(), 0);
  (f.ctx as any).isIdle = () => true;
  await f.emit('agent_settled', { aborted: false });
  assert.equal(f.sent.length, 2, 'the command is sent again');
  await f.commands.get(name).handler(token, f.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reloads(), 1); assert.equal(f.latest().state, 'resuming');
});

test('failed reload is recorded, not resumed or retried', async () => {
  const f = fixture(); await f.request(); await f.emit('agent_settled', { aborted: false });
  (f.ctx as any).reload = async () => { throw new Error('fixture reload failed'); };
  const [name, token] = f.sent[0][1].slice(1).split(' ');
  await f.commands.get(name).handler(token, f.ctx);
  assert.equal(f.latest().state, 'reloading', 'old extension APIs are not used after a possibly partial reload');
  f.attach(); await f.emit('session_start', { reason: 'reload' });
  assert.equal(f.sent.length, 1); assert.equal(f.latest().state, 'cancelled');
});
