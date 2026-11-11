import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldRuns, parseArgs, quantile, summarize } from '../scripts/worker-cache-stats.mjs';

const row = (runId: string, date: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ role: 'subagent', runId, date, provider: 'anthropic', model: 'claude-sonnet-5-5', usage: { input: 1, cacheWrite: 0, cacheRead: 0, cost: { total: 0, cacheWrite: 0 }, ...usage }, ...extra });

test('worker cache stats: one record per run with its first call, totals and cost; other roles, days and providers are left out', () => {
  const rows = [
    row('a', '2026-11-09T10:00:00Z', { cacheWrite: 30_000, cost: { total: 0.2, cacheWrite: 0.1 } }),
    row('a', '2026-11-09T10:01:00Z', { cacheWrite: 500, cacheRead: 30_000, cost: { total: 0.05, cacheWrite: 0.01 } }),
    row('b', '2026-11-10T10:00:00Z', { cacheWrite: 10_000, cacheRead: 20_000, cost: { total: 0.1, cacheWrite: 0.04 } }),
    { ...row('c', '2026-11-10T11:00:00Z', { cacheWrite: 1 }), role: 'main' },
    row('d', '2026-11-12T11:00:00Z', { cacheWrite: 1 }),
    row('e', '2026-11-10T11:00:00Z', { cacheWrite: 1 }, { provider: 'openai-codex' }),
  ];
  const runs = foldRuns(rows, { since: '2026-11-09', until: '2026-11-11', provider: '^anthropic' });
  assert.deepEqual(runs.map(run => run.runId), ['a', 'b']);
  assert.equal(runs[0].firstWrite, 30_000);
  assert.equal(runs[0].totalWrite, 30_500);
  assert.equal(runs[0].calls, 2);
  assert.equal(runs[0].firstRead, 0);
  assert.ok(Math.abs(runs[0].cost - 0.25) < 1e-9);
  const summary = summarize(runs);
  assert.deepEqual([summary.runs, summary.calls, summary.firstCallWarm], [2, 3, 1]);
  assert.equal(summary.firstWrite.median, 10_000, 'the lower of two is the median by nearest rank');
  assert.equal(summary.firstWrite.p90, 30_000);
  assert.equal(summary.totalWrite.sum, 40_500);
});

test('worker cache stats: quantile by nearest rank, and the options are checked', () => {
  assert.equal(quantile([], 0.5), undefined);
  assert.equal(quantile([5, 1, 9, 3, 7], 0.5), 5);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.deepEqual({ ...parseArgs(['--since', '2026-11-09', '--json', 'x.jsonl']) }, { ...parseArgs([]), since: '2026-11-09', json: true, file: 'x.jsonl' });
  assert.throws(() => parseArgs(['--since', 'yesterday']), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.throws(() => parseArgs(['--until']), /needs a value/);
});
