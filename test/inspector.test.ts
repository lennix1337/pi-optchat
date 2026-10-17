import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth, type Component } from '@earendil-works/pi-tui';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { fit, Inspector, short, type InspectorAction } from '../src/inspector.ts';
import { emptyUsage, UsageLedger } from '../src/usage.ts';
import { RunHistory } from '../src/runs.ts';
import { mountNavigation } from '../src/navigation.ts';
import { removeDir } from './support.ts';
import { ShellJobs } from '../src/shells.ts';

// Children load installed extensions from Pi's agent dir; keep tests away from the user's real one.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

test('inspector reaches old runs, opens the selected agent, shows usage, resizes, and shuts down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-inspector-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const usage = new UsageLedger(dir), controller = new AbortController();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  for (let i = 0; i < 100; i++) children.history.records.set(`run-${i}`, { id: `run-${i}`, task: `Task ${i} ${'long title '.repeat(20)}`, cwd: dir, model: 'openai-codex/gpt-6-luna', thinking: 'xhigh',
    parentSession: 'parent', depth: 1, started: 1000 - i, ended: 2000, state: 'completed', guidance: [] });
  const spend = (role: 'main' | 'compactor', model: string, cost: number, provider?: string) => usage.add({ date: new Date().toISOString(), role, model, provider, session: 'parent',
    usage: { input: 0, output: 164_000, cacheRead: 900, cacheWrite: 100, totalTokens: 165_000, cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost } } });
  spend('main', 'claude-opus-5-5', 20.5, 'anthropic'); spend('main', 'evil\n\x1b[2Jmodel', 0); spend('compactor', 'claude-sonnet-5-5', 60, 'anthropic'); spend('compactor', 'claude-sonnet-5-5', 3.35);
  let rows = 24;
  const actions: (InspectorAction | undefined)[] = [];
  const open = (page: 'agents' | 'usage') => new Inspector({ profile: 'personal', session: 'parent', children, usage, memory, page, rows: () => rows, redraw: () => {}, done: action => { actions.push(action); }, color: (_tone, text) => text, context: () => 123, signal: controller.signal });
  const inspector = open('agents'), usagePage = open('usage');
  try {
    inspector.handleInput('\x1b[F');
    assert.match(inspector.render(100).find(l => l.startsWith(' →')) ?? '', /Task 99/);
    assert.match(inspector.render(100).join('\n'), /Enter open/);
    assert.match(inspector.render(100).join('\n'), /gpt-6-luna\(xhigh\)/);
    for (const width of [18, 40, 64, 100, 160]) assert.ok(inspector.render(width).every(line => visibleWidth(line) <= width));
    inspector.handleInput('\r');
    assert.deepEqual(actions, [{ open: 'run-99' }]);
    const table = usagePage.render(100).filter(l => /claude-opus|claude-sonnet/.test(l));
    // Provider identity separates same-named models; older records without it remain visible as unknown.
    assert.deepEqual(table.map(l => l.trim().split(/\s+/)), [
      ['main', 'anthropic/claude-opus-5-5', '$20.50', '24%', '164k', '90%'],
      ['compactor', 'anthropic/claude-sonnet-5-5', '$60.00', '72%', '164k', '90%'],
      ['unknown/claude-sonnet-5-5', '$3.35', '4%', '164k', '90%'],
    ]);
    assert.equal(table[0].indexOf('$20.50') + 6, table[1].indexOf('$60.00') + 6);
    assert.match(usagePage.render(100).join('\n'), /estimated API cost/);
    assert.match(usagePage.render(100).join('\n'), /not a provider bill/);
    // Untrusted model metadata is omitted rather than stored/rendered into the table.
    assert.ok(usagePage.render(100).some(l => /unknown\/unknown/.test(l)));
    assert.ok(usagePage.render(100).every(l => !l.includes('\x1b')));
    assert.doesNotMatch(usagePage.render(40).join('\n'), /claude-/);
    usagePage.handleInput('\x1b[C');
    assert.match(usagePage.render(100).join('\n'), /\[Last.hour\]/);
    rows = 16;
    const narrow = usagePage.render(40);
    assert.ok(narrow.length <= Math.floor(rows * 0.9));
    assert.ok(narrow.every(line => visibleWidth(line) <= 40));
    controller.abort(); usagePage.handleInput('\x1b'); assert.equal(actions.length, 2);
  } finally { inspector.dispose(); usagePage.dispose(); await children.close(); await memory.close(); removeDir(dir); }
});

test('d twice deletes the selected agent and the agents it started; any other key cancels the first press', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-inspector-delete-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  const run = (id: string, started: number, parentId?: string) => children.history.save({ id, task: `Task ${id}`, cwd: dir, model: 'test', thinking: 'high',
    parentSession: 'parent', depth: parentId ? 2 : 1, parentId, started, ended: started + 1, state: 'completed', guidance: [] });
  run('old', 1); run('parent', 3); run('child', 4, 'parent'); run('newest', 5);
  const inspector = new Inspector({ profile: 'personal', session: 'parent', children, usage: new UsageLedger(dir), memory, page: 'agents', rows: () => 24, redraw: () => {}, done: () => {}, color: (_tone, text) => text, context: () => undefined });
  const selected = () => inspector.render(100).find(l => l.startsWith(' →')) ?? '';
  const footer = () => inspector.render(100).at(-2) ?? '';
  try {
    inspector.handleInput('\x1b[B');
    assert.match(selected(), /Task parent/);
    inspector.handleInput('d');
    assert.match(footer(), /Press d again to delete this agent and the agents it started/);
    inspector.handleInput('x');
    assert.match(footer(), /d delete/, 'another key cancels');
    inspector.handleInput('d');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(children.history.records.has('parent'), 'one press deletes nothing');
    inspector.handleInput('d');
    await until(() => !children.history.records.has('parent'));
    assert.deepEqual([...children.history.records.keys()].sort(), ['newest', 'old'], 'its child went with it');
    assert.ok(!existsSync(join(dir, 'runs', 'child.optchat.json')));
    assert.match(selected(), /Task old/, 'the cursor moves to the next row');
    // Moved onto a row that goes with the one being deleted, the cursor still lands on a row that remains.
    inspector.handleInput('\x1b[A');
    assert.match(selected(), /Task newest/);
    run('kept', 2); run('gone', 6); run('gone-child', 7, 'gone');
    inspector.handleInput('\x1b[H');
    assert.match(selected(), /Task gone$|Task gone /);
    inspector.handleInput('d'); inspector.handleInput('d'); inspector.handleInput('\x1b[B');
    assert.match(selected(), /Task gone-child/);
    await until(() => !children.history.records.has('gone'));
    assert.match(selected(), /Task newest/);
  } finally { inspector.dispose(); await children.close(); await memory.close(); removeDir(dir); }
});

test('Usage keeps sub-cent API estimates visible and labels zero or unknown model rates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-subcent-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const usage = new UsageLedger(dir), now = new Date().toISOString();
  const add = (model: string, provider: string, cost: number) => usage.add({ date: now, role: 'main', model, provider, session: 'parent',
    usage: { ...emptyUsage(), output: 1, totalTokens: 1, cost: { ...emptyUsage().cost, output: cost, total: cost } } });
  add('small', 'provider-a', 0.0042); add('tiny', 'provider-b', 0.00003); add('unpriced', 'provider-c', 0);
  usage.add({ date: now, role: 'main', model: 'unpriced', provider: 'provider-c', session: 'parent', kind: 'conversation', outcome: 'error', failed: true, usage: emptyUsage() });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  const page = new Inspector({ profile: 'personal', session: 'parent', children, usage, memory, page: 'usage', rows: () => 40, redraw: () => {}, done: () => {},
    color: (_tone, text) => text, context: () => undefined });
  try {
    const lines = page.render(140);
    assert.ok(lines.some(line => line.includes('$0.0042 estimated API cost')));
    assert.ok(lines.some(line => /provider-a\/small\s+\$0\.0042/.test(line)));
    assert.ok(lines.some(line => /provider-b\/tiny\s+<\$0\.0001/.test(line)));
    assert.ok(lines.some(line => /provider-c\/unpriced · 1 failed\s+\$0\.00/.test(line)));
    assert.ok(lines.some(line => /1 failed/.test(line)));
    assert.ok(lines.some(line => line.includes('$0.00 may mean unknown or zero model pricing')));
  } finally { page.dispose(); await children.close(); await memory.close(); removeDir(dir); }
});

test('agent rows distinguish queued and undelivered guidance from current activity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-agent-guidance-status-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  const now = Date.now();
  children.history.records.set('queued', { id: 'queued', task: 'queued task', cwd: dir, model: 'test', thinking: 'high', parentSession: 'parent', depth: 1, started: now - 30_000, state: 'running',
    guidance: [{ text: 'wait for this', date: now, state: 'queued', from: 'user' }] });
  children.history.records.set('offline', { id: 'offline', task: 'offline task', cwd: dir, model: 'test', thinking: 'high', parentSession: 'parent', depth: 1, started: now - 30_000, ended: now, state: 'interrupted',
    guidance: [{ text: 'not delivered', date: now, state: 'undelivered', from: 'user' }] });
  const fakeLive = { updated: now - 30_000, tools: new Map([['tool-1', { name: 'run_command', args: {}, started: now - 30_000 }]]) } as unknown as NonNullable<ReturnType<Children['live']>>;
  Object.defineProperty(children, 'live', { value: (id: string) => id === 'queued' ? fakeLive : undefined });
  const page = new Inspector({ profile: 'personal', session: 'parent', children, usage: new UsageLedger(dir), memory, page: 'agents', rows: () => 40, redraw: () => {}, done: () => {},
    color: (_tone, text) => text, context: () => undefined });
  try {
    const rows = page.render(140);
    const queued = rows.find(line => line.includes('queued task')) ?? '';
    const offline = rows.find(line => line.includes('offline task')) ?? '';
    assert.match(queued, /1 message queued · run_command · updated \d+s ago/);
    assert.match(offline, /interrupted · 1 message not delivered/);
  } finally { page.dispose(); await children.close(); await memory.close(); removeDir(dir); }
});

test('Tab cycles Agents, Usage, Activity and Shells; Activity is a memory gauge with an agent count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-activity-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  let progress: ReturnType<Memory['progress']> = { done: 0, total: 0, retryIn: undefined };
  const fake = { root: memory.root, size: 97_400, budget: 128_000, lastError: undefined as string | undefined, progress: () => progress, onChange: () => () => {} };
  for (let i = 0; i < 3; i++) memory.append('user', `message ${i}`);
  const inspector = new Inspector({ profile: 'personal', session: 'parent', children, usage: new UsageLedger(dir), memory: fake, page: 'agents',
    rows: () => 40, redraw: () => {}, done: () => {}, color: (_tone, text) => text, context: () => undefined });
  const title = () => inspector.render(100)[1].trim().split(/\s{2,}/)[0];
  const page = () => inspector.render(100).slice(3, -3).map(l => l.trim()).filter(Boolean);
  try {
    assert.equal(title(), 'OptChat · personal · Agents');
    inspector.handleInput('\t'); assert.equal(title(), 'OptChat · personal · Usage');
    inspector.handleInput('\t'); assert.equal(title(), 'OptChat · personal · Activity');
    assert.deepEqual(page(), ['Memory · 3 messages · view 97 KB / 128 KB', 'Settled', 'Agents · 0 running']);
    progress = { done: 12, total: 40, retryIn: 7_000 }; fake.lastError = '429 rate_limit_error';
    children.history.records.set('run', { id: 'run', task: 'review', cwd: dir, model: 'test', thinking: 'high', parentSession: 'parent', depth: 1, started: Date.now(), state: 'running', guidance: [] });
    assert.deepEqual(page(), ['Memory · 3 messages · view 97 KB / 128 KB', 'Catching up · 12 of 40 summaries  ███░░░░░░░', '429 rate_limit_error · retry in 7s',
      'Agents · 1 running']);
    children.history.records.set('paused', { id: 'paused', task: 'wait', cwd: dir, model: 'test', thinking: 'high', parentSession: 'parent', depth: 1, started: Date.now(), state: 'paused', guidance: [] });
    assert.equal(page().at(-1), 'Agents · 1 running · 1 interrupted', 'an interrupted agent is neither running nor finished');
    inspector.handleInput('\t'); assert.equal(title(), 'OptChat · personal · Shells');
    inspector.handleInput('\t'); assert.equal(title(), 'OptChat · personal · Agents');
  } finally { inspector.dispose(); await children.close(); await memory.close(); removeDir(dir); }
});

test('the Activity bar item shows a dot only while summaries or agents are at work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bar-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  let total = 0, widget: Component | undefined;
  const fake = { progress: () => ({ done: 0, total, retryIn: undefined }), onChange: () => () => {} };
  const ctx = { ui: { getEditorComponent: () => () => undefined, setWidget: (_key: string, factory?: (tui: unknown, theme: unknown) => Component) => { widget = factory?.({ requestRender() {} }, { fg: (_tone: string, text: string) => text }); } } };
  const unmount = mountNavigation(ctx as unknown as ExtensionContext, children, fake, 'f6', () => {});
  const bar = () => widget?.render(120).join('') ?? '';
  try {
    assert.doesNotMatch(bar(), /●/);
    total = 5; assert.match(bar(), /Usage {3}● Activity/);
    total = 0; children.history.records.set('run', { id: 'run', task: 'review', cwd: dir, model: 'test', thinking: 'high', parentSession: 'parent', depth: 1, started: Date.now(), state: 'paused', guidance: [] });
    assert.match(bar(), /Agents: 0 running · 1 interrupted · 0 saved/);
    assert.doesNotMatch(bar(), /●/, 'an agent waiting for the user is not at work');
    children.history.records.get('run')!.state = 'running';
    assert.match(bar(), /● Activity/);
  } finally { unmount(); await children.close(); await memory.close(); removeDir(dir); }
});

test('unfinished persisted runs recover as interrupted with undelivered guidance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-run-history-'));
  try {
    const history = new RunHistory(dir);
    history.save({ id: 'interrupted', task: 'work', cwd: dir, model: 'test', thinking: 'high', parentSession: 'parent', depth: 1, started: 1, state: 'running',
      guidance: [{ text: 'additional task', date: 2, state: 'queued' }] });
    const restored = new RunHistory(dir).records.get('interrupted');
    assert.equal(restored?.state, 'interrupted');
    assert.equal(restored?.guidance[0].state, 'undelivered');
  } finally { removeDir(dir); }
});

test('agent titles shorten at a word boundary with an ellipsis', () => {
  assert.equal(fit('Read-only review of PR #7 in jonaslsaa/pi-optchat', 30), 'Read-only review of PR #7 in…');
  assert.equal(fit('github.com/jonaslsaa/pi-optchat/pull/7', 12), 'github.com/…');
  assert.equal(fit('review #6', 30), 'review #6');
});

test('short numbers move up a unit instead of showing 1000', () => {
  assert.deepEqual([999, 999.6, 12_345, 164_000, 999_499, 999_500, 999_500_000, 2_400_000].map(short), ['999', '1k', '12.3k', '164k', '999k', '1M', '1B', '2.4M']);
});

test('Shells panel shows output safely, stays within narrow terminals and confirms individual stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-shell-ui-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  const shells = new ShellJobs();
  const id = shells.start('node server.js', dir, async (signal, update) => {
    update('Listening on 3000\n\x1b[2Junsafe control\n' + 'long output '.repeat(100));
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    return { output: 'Stopped', failed: false };
  });
  let done = false;
  const inspector = new Inspector({ profile: 'test', session: 'session', children, usage: new UsageLedger(dir), memory, shells, page: 'shells',
    rows: () => 24, redraw: () => {}, done: () => { done = true; }, color: (_tone, text) => text, context: () => undefined });
  try {
    await Promise.resolve();
    assert.match(inspector.render(100).join('\n'), /node server.js.*running.*background/);
    inspector.handleInput('\r');
    assert.match(inspector.render(100).join('\n'), /Listening on 3000/);
    for (const width of [30, 40, 80, 120]) {
      const lines = inspector.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.ok(lines.every(line => !line.includes('\x1b')));
      assert.ok(lines.length <= 24);
    }
    inspector.handleInput('k'); assert.match(inspector.render(100).join('\n'), /Enter stop/);
    inspector.handleInput('\x1b'); assert.equal(shells.list()[0].state, 'running');
    inspector.handleInput('k'); inspector.handleInput('\r');
    assert.equal(shells.list().find(j => j.id === id)?.state, 'stopping');
    await shells.close(); assert.match(inspector.render(100).join('\n'), /stopped/);
    inspector.handleInput('\x1b'); assert.equal(done, false, 'Escape returns from output to list');
    inspector.handleInput('\x1b'); assert.equal(done, true);
  } finally { inspector.dispose(); await shells.close(); await children.close(); await memory.close(); removeDir(dir); }
});

test('shell count remains visible on narrow footers and updates immediately', () => {
  const shells = new ShellJobs(); let widget: Component | undefined, redraws = 0;
  const children = { history: { list: () => [] }, subscribe: () => () => {} } as unknown as Children;
  const memory = { progress: () => ({ done: 0, total: 0, retryIn: undefined }), onChange: () => () => {} };
  const ctx = { ui: { getEditorComponent: () => () => undefined, setWidget: (_key: string, factory?: (tui: unknown, theme: unknown) => Component) => {
    widget = factory?.({ requestRender() { redraws++; } }, { fg: (_tone: string, text: string) => text });
  } } };
  const unmount = mountNavigation(ctx as unknown as ExtensionContext, children, memory, 'f6', () => {}, shells);
  try {
    shells.begin('one', 'node server', '.', 'foreground');
    assert.ok(redraws > 0);
    for (const width of [30, 40, 80, 120]) {
      const bar = widget?.render(width).join('') ?? '';
      assert.match(bar, /Shells: 1/); assert.ok(visibleWidth(bar) <= width);
    }
    shells.end('one', 'done', false); assert.match(widget?.render(80).join('') ?? '', /Shells: 0/);
  } finally { unmount(); }
});
