import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Commitment } from '../src/commitments.ts';
import { forecast, type PrOutlook } from '../src/forecast.ts';
import { composeSummary, nextSeen, outlook } from '../src/slack-reports.ts';

const now = Date.parse('2026-10-31T10:00:00Z'); // 07:00 in Brasília
const H = 3_600_000;
const commitment = (id: string, due: string | undefined, status: Commitment['status'] = 'open'): Commitment => ({
  id, text: `tarefa ${id}`, owner: 'optchat', source: '1', createdAt: '2026-10-31T09:00:00Z', updatedAt: '2026-10-31T09:00:00Z',
  progressAt: '2026-10-31T09:00:00Z', status, notes: [], ...due ? { due } : {},
});
const pr = (n: number, ci: string, sinceH: number, flips = 0): PrOutlook => ({ title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, ci, since: now - sinceH * H, flips });

test('the forecast names what tends to go wrong today and stays quiet about healthy work', () => {
  const lines = forecast({
    now,
    commitments: [
      commitment('c1', '2026-10-31T20:00:00Z'), // due today 17:00
      commitment('c2', '2026-11-02T20:00:00Z'), // due in two days: not today's risk
      commitment('c3', '2026-10-31T08:00:00Z'), // overdue: listed by the overdue section, not here
      commitment('c4', '2026-10-31T12:00:00Z', 'done'),
    ],
    prs: [pr(1, 'FAILURE', 5), pr(2, 'PENDING', 3), pr(3, 'PENDING', 0.5), pr(4, 'SUCCESS', 1, 3), pr(5, 'SUCCESS', 72), pr(6, 'SUCCESS', 5)],
    health: { 'API DentAI': { failures: 3, down: true, since: now - H, problem: 'HTTP 502' }, Site: { failures: 0, down: false, since: now - 9 * H } },
  });
  assert.deepEqual(lines, [
    '🔴 API DentAI fora desde 06:00 (HTTP 502): investigar antes de qualquer deploy',
    '⏰ vence às 17:00: tarefa c1',
    '❌ CI vermelha há 5 h: <https://github.com/o/r/pull/1|r#1> PR 1',
    '⏳ CI pendente há 3 h (travada?): <https://github.com/o/r/pull/2|r#2> PR 2',
    '🎲 CI instável (mudou 3× de verde/vermelho): <https://github.com/o/r/pull/4|r#4> PR 4',
    '💤 parado há 3 dias: <https://github.com/o/r/pull/5|r#5> PR 5',
  ]);
});

test('a PR record keeps when its state began and counts CI verdict flips, not pending runs', () => {
  let seen = { sig: 'OPEN:PENDING', seen: 0, title: 't', url: 'u', channel: 'harness', ...nextSeen(undefined, 'OPEN:PENDING', 100) };
  assert.deepEqual([seen.since, seen.flips, seen.verdict], [100, 0, undefined]);
  seen = { ...seen, sig: 'OPEN:PENDING', ...nextSeen(seen, 'OPEN:PENDING', 200) };
  assert.equal(seen.since, 100, 'an unchanged state keeps its start');
  const steps: [string, number][] = [['OPEN:SUCCESS', 0], ['OPEN:PENDING', 0], ['OPEN:FAILURE', 1], ['OPEN:SUCCESS', 2], ['OPEN:ERROR', 3]];
  let t = 300;
  for (const [sig, flips] of steps) {
    seen = { ...seen, sig, ...nextSeen(seen, sig, t) };
    assert.deepEqual([seen.since, seen.flips], [t, flips], sig);
    t += 100;
  }
  assert.equal(seen.verdict, 'red');
  assert.deepEqual(outlook({ sig: 'OPEN:FAILURE', seen: 50, title: 't', url: 'u', channel: 'c' }), { title: 't', url: 'u', ci: 'FAILURE', since: 50, flips: 0 }, 'old records fall back to their last sighting');
});

test('the morning summary carries the forecast, and says so when nothing is expected', () => {
  const base = { day: [], waiting: [], prs: [], approvals: 0 };
  assert.match(composeSummary({ ...base, risks: ['⏰ vence às 17:00: x'] }), /\*Pode dar problema hoje\*\n• ⏰ vence às 17:00: x/);
  assert.match(composeSummary({ ...base, risks: [] }), /\*Pode dar problema hoje\*\n• Nada previsto\./);
});
