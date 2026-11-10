import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareMetrics, crewMetrics, crewStats } from '../scripts/crew-stats.mjs';
import type { ManagerMetrics, WakeMetrics, WorkerMetrics } from '../scripts/crew-stats.mjs';

const row = (date: string, role: string, model: string, cost: number, totalTokens: number) =>
  JSON.stringify({ date, role, model, usage: { totalTokens, cost: { total: cost } } });

test('crew stats sums main Opus calls and cost inside the window only', () => {
  const lines = [
    row('2026-11-01T00:00:00Z', 'main', 'claude-opus-5-5', 9, 100),
    row('2026-11-05T00:00:00Z', 'main', 'claude-opus-5-5', 1.25, 1000),
    row('2026-11-05T01:00:00Z', 'main', 'claude-opus-5-5', 0.75, 3000),
    row('2026-11-05T02:00:00Z', 'subagent', 'claude-sonnet-5-5', 0.5, 500),
    'not json',
  ];
  const stats = crewStats(lines, Date.parse('2026-11-02T00:00:00Z'));
  assert.deepEqual(stats.opusMain, { calls: 2, cost: 2 });
  assert.equal(stats.total, 2.5);
  assert.deepEqual(stats.rows[0], { role: 'main', model: 'claude-opus-5-5', calls: 2, cost: 2, tokensPerCall: 2000 });
  assert.equal(stats.rows[1].tokensPerCall, 500);
});

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-10T00:00:00Z');

interface Call { name: string; arguments: Record<string, unknown> }
const assistant = (input: number, cacheRead: number, cacheWrite: number, calls: Call[] = []) => JSON.stringify({
  type: 'message',
  message: { role: 'assistant', content: calls.map(c => ({ type: 'toolCall', ...c })), usage: { input, cacheRead, cacheWrite } },
});
const read = (path: string): Call => ({ name: 'read', arguments: { path } });

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-metrics-'));
  mkdirSync(join(dir, 'runs'));
  return dir;
}

function addRun(dir: string, id: string, run: { kind?: string; project?: string; started: number }, session?: string[]): void {
  const sessionFile = session ? join(dir, 'runs', `${id}.jsonl`) : undefined;
  if (sessionFile) writeFileSync(sessionFile, session!.join('\n'));
  writeFileSync(join(dir, 'runs', `${id}.optchat.json`), JSON.stringify({ id, ...run, sessionFile }));
}

test('crewMetrics counts re-reads by later workers of the same project', () => {
  const dir = profile();
  try {
    addRun(dir, 'a', { kind: 'code', project: 'harness', started: T0 }, [assistant(10, 20, 30, [read('C:\\wt1\\src\\A.ts'), read('c:/wt1/test/b.test.ts')])]);
    // Same files under another worktree root, twice in one run: each file counts once. src/new.ts is first read here.
    addRun(dir, 'b', { kind: 'code', project: 'harness', started: T0 + 2 * HOUR }, [
      assistant(10, 20, 30, [read('/wt2/src/a.ts'), read('/wt2/src/a.ts'), read('/wt2/src/new.ts'), read('/wt2/test/B.test.ts')]),
      assistant(1, 2, 3, [{ name: 'tell_parent', arguments: {} }, { name: 'tell_peer', arguments: {} }, { name: 'bash', arguments: {} }]),
    ]);
    // Another project reading the same file is not a re-read.
    addRun(dir, 'c', { kind: 'code', project: 'dentai', started: T0 + 3 * HOUR }, [assistant(0, 0, 0, [read('/wt3/src/a.ts')])]);
    // More than 24 h after the first reader and after b: b read src/a.ts 30 h earlier -> not a re-read.
    addRun(dir, 'd', { kind: 'mechanical', project: 'harness', started: T0 + 32 * HOUR }, [assistant(0, 0, 0, [read('/wt4/src/a.ts')])]);
    // No kind: not a contract worker, never counted.
    addRun(dir, 'e', { project: 'harness', started: T0 + 4 * HOUR }, [assistant(0, 0, 0, [read('/wt5/src/a.ts')])]);
    const w = crewMetrics(dir, T0 - HOUR, T0 + 100 * HOUR).workers as WorkerMetrics;
    assert.equal(w.contractWorkers, 4);
    assert.equal(w.reads, 8);
    assert.equal(w.reReads, 2);
    assert.deepEqual(w.reReadsByProject, { harness: 2 });
    assert.equal(w.tellParent, 1);
    assert.equal(w.tellPeer, 1);
    assert.equal(w.toolCalls, 11);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crewMetrics measures context per call and counts only workers inside the window, with 24 h lookback', () => {
  const dir = profile();
  try {
    addRun(dir, 'a', { kind: 'code', project: 'harness', started: T0 - 5 * HOUR }, [assistant(100, 0, 0, [read('/x/src/a.ts')])]);
    addRun(dir, 'b', { kind: 'code', project: 'harness', started: T0 + HOUR }, [assistant(200, 100, 0, [read('/y/src/a.ts')]), assistant(300, 100, 100)]);
    addRun(dir, 'c', { kind: 'code', project: 'harness', started: T0 + 2 * HOUR }, [assistant(1000, 0, 0), assistant(0, 0, 0)]);
    addRun(dir, 'missing', { kind: 'code', project: 'harness', started: T0 + 3 * HOUR });
    const w = crewMetrics(dir, T0, T0 + 10 * HOUR).workers as WorkerMetrics;
    assert.equal(w.contractWorkers, 3);
    assert.equal(w.sessionsMissing, 1);
    assert.equal(w.reReads, 1, 'the earlier reader sits before the window but inside 24 h');
    assert.equal(w.contextPerCall, (300 + 500 + 1000 + 0) / 4);
    assert.equal(w.firstCallContextMedian, 650);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crewMetrics separates empty and quota wakes, merges extra wake files without duplicates and reports absent daily as unavailable', () => {
  const dir = profile();
  try {
    const wake = (at: number, outcome: string, extra: Record<string, unknown> = {}) => ({ at, trigger: 'schedule', outcome, ...extra });
    writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ wakeLog: [
      wake(T0 + 1, 'done', { commits: [] }),
      wake(T0 + 2, 'done', { commits: ['abc'] }),
      wake(T0 + 3, 'error', { reply: 'You have hit your usage limit' }),
      wake(T0 - 1, 'done', { commits: [] }),
    ] }));
    mkdirSync(join(dir, 'crew'));
    writeFileSync(join(dir, 'crew', 'extra.json'), JSON.stringify({ wakeLog: [
      wake(T0 + 3, 'error', { reply: 'You have hit your usage limit' }),
      wake(T0 + 4, 'error', { reply: 'Error: 429 Too Many Requests' }),
      wake(T0 + 5, 'error', { reply: 'TypeError: boom' }),
      wake(T0 + 6, 'interrupted'),
    ] }));
    const wakes = crewMetrics(dir, T0, T0 + HOUR, { wakesFile: join(dir, 'crew', 'extra.json') }).wakes as WakeMetrics;
    assert.deepEqual(
      { total: wakes.total, done: wakes.done, empty: wakes.empty, errors: wakes.errors, quotaErrors: wakes.quotaErrors, interrupted: wakes.interrupted },
      { total: 6, done: 2, empty: 1, errors: 3, quotaErrors: 2, interrupted: 1 },
    );
    assert.equal(wakes.daily, 'unavailable');
    assert.equal((crewMetrics(dir, T0, T0 + HOUR).wakes as WakeMetrics).total, 3, 'without the extra file only heartbeat.json counts');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crewMetrics sums daily counters when heartbeat.json has them and reports missing sources as unavailable, never 0', () => {
  const dir = profile();
  try {
    writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ wakeLog: [], daily: [
      { day: '2026-11-09', wakes: 9, errors: 9, skippedQuota: 9, skippedIdle: 9 },
      { day: '2026-11-10', wakes: 4, errors: 1, skippedQuota: 2, skippedIdle: 3 },
      { day: '2026-11-11', wakes: 1, errors: 0, skippedQuota: 0, skippedIdle: 1 },
    ] }));
    const m = crewMetrics(dir, T0, T0 + 36 * HOUR);
    assert.deepEqual((m.wakes as WakeMetrics).daily, { wakes: 5, errors: 1, skippedQuota: 2, skippedIdle: 4 });
    assert.equal(m.manager, 'unavailable');
    assert.equal(m.opusMain, 'unavailable');
    assert.equal(m.total, 'unavailable');
    const bare = crewMetrics(mkdtempSync(join(tmpdir(), 'crew-metrics-empty-')), T0, T0 + HOUR);
    assert.equal(bare.workers, 'unavailable');
    assert.equal(bare.wakes, 'unavailable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crewMetrics counts manager tells, spawns and mid-run worker messages inside the window', () => {
  const dir = profile();
  try {
    mkdirSync(join(dir, 'main'));
    const entry = (i: number, kind: string, text: string, date: string) => JSON.stringify({ i, kind, text, date });
    writeFileSync(join(dir, 'main', '2026-11-10.jsonl'), [
      entry(1, 'tool', 'tell {"to":"x"}', '2026-11-10T01:00:00Z'),
      entry(2, 'tool', 'spawn {"kind":"code"}', '2026-11-10T02:00:00Z'),
      entry(3, 'tool', 'spawn {"kind":"hard"}', '2026-11-10T02:30:00Z'),
      entry(4, 'work', '[x] Message from subagent (still running): hi', '2026-11-10T03:00:00Z'),
      entry(5, 'work', '[x] report done', '2026-11-10T03:30:00Z'),
      entry(6, 'echo', 'tell is mentioned', '2026-11-10T04:00:00Z'),
      entry(7, 'tool', 'tell {"late":1}', '2026-11-11T01:00:00Z'),
    ].join('\n'));
    const m = crewMetrics(dir, T0, T0 + 12 * HOUR).manager as ManagerMetrics;
    assert.deepEqual(m, { tells: 1, spawns: 2, workerMessages: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compareMetrics reports current, baseline and delta per key, and leaves keys the baseline lacks without delta', () => {
  const current = { opusMain: { calls: 10, cost: 5.5 }, total: 8, rows: [{ role: 'main', model: 'm', calls: 4, cost: 1, tokensPerCall: 100 }], workers: { reReads: 7 }, wakes: 'unavailable' };
  const baseline = { opusMain: { calls: 40, cost: 20 }, total: 30, rows: [{ role: 'main', model: 'm', calls: 8, cost: 2, tokensPerCall: 250 }] };
  const rows = compareMetrics(current, baseline);
  assert.deepEqual(rows['opusMain.calls'], { current: 10, baseline: 40, delta: -30 });
  assert.deepEqual(rows['opusMain.cost'], { current: 5.5, baseline: 20, delta: -14.5 });
  assert.deepEqual(rows['rows[main m].tokensPerCall'], { current: 100, baseline: 250, delta: -150 });
  assert.deepEqual(rows['workers.reReads'], { current: 7 });
  assert.deepEqual(rows['wakes'], { current: 'unavailable' });
});
