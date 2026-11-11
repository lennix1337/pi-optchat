import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleWidth } from '@earendil-works/pi-tui';
import { boardView, type BoardInput } from '../src/waiting-board.ts';
import { renderWaitingBoard } from '../src/navigation.ts';
import { footerRows, FooterState, type FooterInput } from '../src/footer.ts';

/**
 * The whole panel as text: the waiting board above the editor and the footer under it, at 80 and 120 columns, against a checked-in snapshot.
 * `UPDATE_SNAPSHOTS=1` rewrites the files after a wording change worth keeping; the diff then shows in review.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000, HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-11T18:40:00Z'); // 15:40 in Brasília
const plain = (_tone: string, text: string) => text;

const board: BoardInput = {
  now: NOW,
  waiting: [
    { id: 'c1', text: 'DentAI cache HTML: libera o deploy web?', choices: ['sim', 'não'], since: NOW - 44 * HOUR },
    { id: 'c2', text: 'Responder o PR #12', since: NOW - 3 * HOUR },
    { id: 'c3', text: 'Liberar a cota', since: NOW - 2 * HOUR },
    { id: 'c4', text: 'Decidir o nome', since: NOW - HOUR },
  ],
  runs: [
    { id: 'a1b2c3d4', task: 'Goal: aviso só aparece na próxima msg', project: 'gitwatch', model: 'anthropic-account-2/claude-sonnet-5-5', state: 'running', started: NOW - 5 * MIN, updated: NOW - 4_000, toolAt: NOW - 4_000, phase: 'lendo código' },
    { id: 'b2c3d4e5', task: "You are a subagent. Don't write memory pages.\n\nGoal: ↑ abre o quadro + rótulo do agente", project: 'optchat', model: 'anthropic-account-2/claude-sonnet-5-5', state: 'running', started: NOW - MIN, updated: NOW - 9_000, toolAt: NOW - 9_000, phase: 'testes' },
  ],
  shells: [{ id: 'cd8f3ec5-0000', command: 'cd C:/projetos/pi-optchat && grep -n "Inspector" src/index.ts', state: 'completed', started: NOW - 4 * MIN, ended: NOW - 3 * MIN, exitCode: 0 }],
};
const footer: FooterInput = {
  now: NOW, spend: 44.93, context: { tokens: 197_000, window: 1_000_000 },
  quota: { label: 'Claude', w5h: { used: 21, resetAt: Date.parse('2026-11-11T21:39:00Z') }, w7d: { used: 71, resetAt: Date.parse('2026-11-14T21:39:00Z') } },
  goalStatus: 'goal: unfocused [2 open] - /goal-focus',
};

const panel = (width: number) => [...renderWaitingBoard(boardView(board), width, plain, 'F6'), ...footerRows(footer, width, plain, 'F6')];

for (const width of [80, 120]) {
  test(`the whole panel at ${width} columns matches its snapshot and never passes the width`, () => {
    const lines = panel(width), text = `${lines.join('\n')}\n`, file = join(HERE, 'fixtures', `panel-${width}.txt`);
    assert.ok(lines.every(line => visibleWidth(line) <= width), 'every row fits');
    if (process.env.UPDATE_SNAPSHOTS === '1' || !existsSync(file)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }
    assert.equal(text, readFileSync(file, 'utf8'));
  });
}

test('the footer holds today\'s spend, the context, the quota windows with their reset time and the goal state, in Portuguese, nothing else', () => {
  const [rule, line] = footerRows(footer, 200, plain);
  assert.equal(rule, '─'.repeat(200));
  assert.equal(line, '$44,9 hoje · contexto 197k/1M · Claude 5h 21% (18:39) · 7d 71% · meta: 2 em aberto · /goal-focus');
  assert.doesNotMatch(line, /saved|\bR\d|\bW\d|\bCH\d|agent/i);
});

test('a narrow terminal drops the least important parts first, and a quota near its limit changes tone', () => {
  const widths = [90, 60, 40, 30].map(width => footerRows(footer, width, plain)[1]);
  assert.deepEqual(widths, ['$44,9 hoje · contexto 197k/1M · Claude 5h 21% (18:39) · 7d 71%', '$44,9 hoje · contexto 197k/1M · Claude 5h 21% (18:39)', '$44,9 hoje · Claude 5h 21% (18:39)', '$44,9 hoje']);
  const tone = (used: number, context?: FooterInput['context']) => footerRows({ ...footer, context, quota: { label: 'Claude', w5h: { used, resetAt: NOW + HOUR } } }, 200, (t, x) => `<${t}>${x}</>`)[1];
  assert.match(tone(85), /<warning>Claude 5h 85% \(\d\d:\d\d\)<\/>/);
  assert.match(tone(97), /<error>Claude 5h 97%/);
  assert.match(tone(10, { tokens: 900_000, window: 1_000_000 }), /<warning>contexto 900k\/1M<\/>/);
  assert.match(footerRows({ ...footer, quota: { label: 'Claude', w5h: { used: 90, resetAt: NOW - MIN } } }, 200, plain)[1], /Claude 5h \?/, 'a renewed window is an old reading');
});

test('the footer state reads its sources at most once per few seconds, and a failing source only hides its part', () => {
  let reads = 0, clock = NOW;
  const ctx = { getContextUsage: () => ({ tokens: 100_000, contextWindow: 1_000_000, percent: 10 }), model: { id: 'claude-sonnet-5-5', provider: 'anthropic-account-2', contextWindow: 1_000_000 } };
  const state = new FooterState(ctx as never, { now: () => clock, spend: () => { reads++; return 3.25; },
    quotaState: () => ({ usageByProvider: { 'anthropic-account-2': { primary: { usedPercent: 21, resetAt: NOW + HOUR } } } }) });
  const input = state.input(undefined);
  assert.deepEqual([input.spend, input.context, input.quota?.label, input.quota?.w5h?.used], [3.25, { tokens: 100_000, window: 1_000_000 }, 'Claude', 21]);
  state.input(undefined); state.input('goal: x');
  assert.equal(reads, 1);
  clock += 11_000; state.input(undefined);
  assert.equal(reads, 2);
  const broken = new FooterState({ getContextUsage: () => { throw new Error('gone'); }, model: undefined } as never, { spend: () => { throw new Error('no ledger'); }, quotaState: () => { throw new Error('no file'); } });
  const none = broken.input('goal: x');
  assert.deepEqual([none.spend, none.context, none.quota, none.goalStatus], [undefined, undefined, undefined, 'goal: x']);
});
