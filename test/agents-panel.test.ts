import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { Inspector } from '../src/inspector.ts';
import { UsageLedger } from '../src/usage.ts';
import type { RunInfo } from '../src/runs.ts';
import { compact, modelColumn, panelOrder, shortModel, stateCounts, taskLabel, toolBrief } from '../src/agent-rows.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

const NOW = Date.UTC(2026, 10, 12, 15, 0, 0), MIN = 60_000, HOUR = 60 * MIN;
const PREFIX = "You are a subagent. Don't write memory pages.\n\nGoal: ";
const SONNET = 'anthropic-account-2/claude-sonnet-5-5';

function run(id: string, task: string, over: Partial<RunInfo> = {}): RunInfo {
  return { id, task: `${PREFIX}${task}`, cwd: 'C:/projetos/pi-optchat/.worktrees/agents-view', model: SONNET, thinking: 'high', parentSession: 'parent', depth: 1,
    started: NOW - HOUR, ended: NOW - 30 * MIN, state: 'completed', guidance: [], ...over };
}
/** One running, one failed, five completed runs, the way a manager's Agents page looks. */
export const fixture = (): RunInfo[] => [
  ...[5, 4, 3, 2, 1].map(i => run(`done-${i}`, `Finish step ${i} of the migration. Then report.`, { project: 'harness', kind: 'code', started: NOW - i * 3 * HOUR - (i + 1) * 7 * MIN, ended: NOW - i * 3 * HOUR })),
  run('failed-1', 'Fix the flaky reload test in pi-gitwatch. Keep it small.', { project: 'harness', kind: 'code', model: 'anthropic-account-2/claude-haiku-5-5', state: 'failed', started: NOW - 4 * HOUR, ended: NOW - 3 * HOUR }),
  run('run-1', 'in pi-optchat, redesign the Agents rows. Context follows.', { project: 'harness', kind: 'code', started: NOW - 4 * MIN, ended: undefined, state: 'running',
    guidance: [{ text: 'hi', date: NOW, state: 'queued', from: 'manager' }] }),
];

async function render(runs: RunInfo[], width: number, setup: (children: Children) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-agents-panel-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  for (const info of runs) children.history.records.set(info.id, info);
  setup(children);
  const inspector = new Inspector({ profile: 'swlucas05', session: 'parent', children, usage: new UsageLedger(dir), memory, page: 'agents', rows: () => 40, redraw: () => {}, done: () => {},
    color: (_tone, text) => text, context: () => undefined, now: () => NOW });
  try { return { lines: inspector.render(width), inspector }; } finally { inspector.dispose(); await children.close(); await memory.close(); removeDir(dir); }
}
const liveRun = (children: Children, id: string, tools: Map<string, { name: string; args: unknown; started: number }>) => {
  const info = children.history.records.get(id)!;
  (children as unknown as { running: Map<string, unknown> }).running.set(id, { info, session: {}, updated: NOW - 3000, tools, pendingReports: [], pendingGuidance: [] });
};

test('Agents page: the run is shown by its own goal, the live one first with what it does, the model only when unusual', async () => {
  const bash = new Map([['t1', { name: 'bash', args: { command: 'npx tsc --noEmit -p .' }, started: 0 }]]);
  const { lines } = await render(fixture(), 160, children => liveRun(children, 'run-1', bash));
  if (process.env.SHOW_PANEL) console.log(lines.join('\n'));
  const text = lines.join('\n'), rows = lines.filter(l => /^ [ →] /.test(l));
  assert.equal(rows.length, 7);
  assert.doesNotMatch(text, /You are a subagent|Don't write memory pages|Goal:/, 'the shared brief prefix is not displayed');
  assert.match(rows[0], /^ → harness·code in pi-optchat, redesign the Agents rows\./, 'the running agent comes first, selected');
  assert.match(rows[0], /bash: npx tsc --noEmit -p \. · 1 message queued · 3s ago/, 'and says what it does now');
  assert.match(rows[1], /harness·code Fix the flaky reload test in pi-gitwatch\. .*failed 3h ago · 1h/, 'the failure of the last day is second');
  assert.match(rows[1], /haiku\s+failed/, 'its different model is named');
  assert.match(rows[2], /Finish step 1 of the migration\..*3h ago · 14m$/, 'completed runs follow, newest first, with age and duration');
  assert.deepEqual(rows.slice(2).map(r => /step (\d)/.exec(r)?.[1]), ['1', '2', '3', '4', '5']);
  assert.equal(text.match(/sonnet/g), null, 'the most common model is not repeated on every row');
  assert.match(lines[1], /OptChat · swlucas05 · Agents\s+1 running · 1 failed today · 5 done$/);
  assert.doesNotMatch(text, /saved|\d+\/\d+/);
  assert.ok(lines.every(l => visibleWidth(l) <= 160));
});

test('Agents page keeps every row inside the width and the goal readable when narrow', async () => {
  for (const width of [18, 40, 64, 100, 160]) {
    const { lines } = await render(fixture(), width);
    assert.ok(lines.every(l => visibleWidth(l) <= width), `width ${width}`);
  }
  const { lines } = await render(fixture(), 64);
  assert.match(lines.join('\n'), /Fix the flaky reload test/);
  assert.match(lines.join('\n'), /3h ago · 14m/);
});

test('Selection follows the shown order: Enter opens the cursor row, Down moves to the failed run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-agents-panel-sel-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'test', model: 'test', thinking: 'high' }), () => '', async () => {}, () => {}, dir);
  for (const info of fixture()) children.history.records.set(info.id, info);
  const actions: unknown[] = [];
  const inspector = new Inspector({ profile: 'p', session: 'parent', children, usage: new UsageLedger(dir), memory, page: 'agents', rows: () => 40, redraw: () => {}, done: a => { actions.push(a); },
    color: (_t, text) => text, context: () => undefined, now: () => NOW });
  try {
    inspector.handleInput('\x1b[B');
    assert.match(inspector.render(160).find(l => l.startsWith(' →')) ?? '', /Fix the flaky reload test/);
    inspector.handleInput('\r');
    assert.deepEqual(actions, [{ open: 'failed-1' }]);
  } finally { inspector.dispose(); await children.close(); await memory.close(); removeDir(dir); }
});

test('taskLabel drops the shared brief prefix and keeps the first sentence of the goal', () => {
  assert.equal(taskLabel("You are a subagent. Don't write memory pages.\n\nGoal: in pi-optchat (your worktree…) fix x.y. More text."), 'in pi-optchat (your worktree…) fix x.y.');
  assert.equal(taskLabel("You are a subagent. Don't run memo.  Goal: diagnose the smoke failure in the MCP repo. Then fix."), 'diagnose the smoke failure in the MCP repo.');
  assert.equal(taskLabel('[This run] You are a code worker.\n\nContext: Resolver o conflito de merge localmente\nmais linhas'), 'Resolver o conflito de merge localmente');
  assert.equal(taskLabel('Check e.g. the build output. Then stop.'), 'Check e.g. the build output.');
  assert.equal(taskLabel("You are a subagent. Don't write memory pages."), "You are a subagent. Don't write memory pages.");
  assert.equal(taskLabel(["You are a subagent. Don't write memory pages.", '', 'Context: the operator wants the board readable.', 'Goal: In pi-optchat, make the waiting board reachable. Then more.', 'Acceptance: tests.'].join('\n')), 'In pi-optchat, make the waiting board reachable.', 'the Goal line wins over an earlier Context line');
  assert.equal(taskLabel("You are a subagent. Don't write memory pages.\n\nGoal:\nfix the flaky wake test in the harness"), 'fix the flaky wake test in the harness');
});

test('shortModel, modelColumn, compact and toolBrief', () => {
  assert.deepEqual(['anthropic-account-2/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5', 'claude-opus-4-1', 'openai-codex/gpt-6.1-sol'].map(shortModel), ['sonnet', 'haiku', 'opus', 'gpt-6.1-sol']);
  const runs = [run('a', 'x'), run('b', 'x'), run('c', 'x', { model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh' }), run('d', 'x', { thinking: 'low' })];
  assert.deepEqual(runs.map(modelColumn(runs)), ['', '', 'gpt-6.1-sol(xhigh)', 'sonnet(low)']);
  assert.deepEqual([45_000, 245_000, 38 * MIN, 3 * HOUR + 5 * MIN, 50 * HOUR].map(compact), ['45s', '4m 05s', '38m', '3h 5m', '2d']);
  assert.equal(toolBrief('read', { path: 'src/x.ts', offset: 3 }), 'read: src/x.ts');
  assert.equal(toolBrief('bash', { command: 'git  status\n' }), 'bash: git status');
  assert.equal(toolBrief('ls', undefined), 'ls');
});

test('panelOrder: live, then failures of the last 24 h, then the rest by recency; a parent stays above its children', () => {
  const day = 24 * HOUR;
  const list = [run('old-fail', 'x', { state: 'failed', ended: NOW - 2 * day }), run('done-new', 'x', { ended: NOW - MIN }), run('fail-new', 'x', { state: 'failed', ended: NOW - 5 * HOUR }),
    run('paused', 'x', { state: 'paused', ended: undefined, started: NOW - 9 * HOUR }), run('done-old', 'x', { ended: NOW - 9 * HOUR }),
    run('root', 'x', { ended: NOW - 10 * HOUR }), run('kid', 'x', { parentId: 'root', depth: 2, state: 'running', ended: undefined })];
  assert.deepEqual(panelOrder(list, NOW).map(r => r.id), ['root', 'kid', 'paused', 'fail-new', 'done-new', 'done-old', 'old-fail']);
  assert.equal(stateCounts(list, NOW), '1 running · 1 paused · 1 failed today · 3 done · 1 older failed');
  assert.equal(stateCounts([], NOW), 'no agents');
});

test('pi-subagents rows keep their π mark, agent name and state', async () => {
  const external = run('ext-1', 'Review the diff for style problems. Report back.', { source: 'pi-subagents', agent: 'reviewer', externalKind: 'async', state: 'running', ended: undefined, started: NOW - 2 * MIN });
  const { lines } = await render([...fixture(), external], 160);
  const row = lines.find(l => l.includes('π ')) ?? '';
  assert.match(row, /π reviewer Review the diff for style problems\..*running via pi-subagents.*2m 00s$/, 'the agent name stands in for the project');
  assert.match(lines[1], /2 running · 1 failed today · 5 done$/);
});
