import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crewStats } from '../scripts/crew-stats.mjs';

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
