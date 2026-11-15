import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPrediction, readPredictions, predictionWeek, donePredictions } from '../src/predictions.ts';
import { composeSummary } from '../src/slack-reports.ts';
import { composeScoreboard } from '../src/scoreboard.ts';
import { retroPrompt } from '../src/daily-retro.ts';

test('prediction store preserves transitions and limits quoted evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'predictions-'));
  try {
    recordPrediction(dir, { day: '2026-11-16', text: 'Revisar PR', status: 'predicted', evidence: 'PR aberto' }, 1000);
    recordPrediction(dir, { day: '2026-11-16', text: 'Revisar PR', status: 'done', evidence: 'https://github.com/a/b/pull/1' }, 2000);
    recordPrediction(dir, { day: '2026-11-16', text: 'Revisar PR', status: 'hit', evidence: 'revisa o PR' }, 3000);
    assert.equal(readPredictions(dir).length, 3);
    assert.deepEqual(predictionWeek(dir, 0, 4000), { hits: 1, total: 1 });
    assert.throws(() => recordPrediction(dir, { day: '2026-11-16', text: 'x', status: 'hit', evidence: 'x'.repeat(501) }, 4000));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('morning summary shows completed predictions only', () => {
  const text = composeSummary({ day: [], waiting: [], prs: [], approvals: 0, predictions: [{ text: 'Revisar PR', link: 'https://github.com/a/b/pull/1' }] });
  assert.match(text, /Você ia pedir: Revisar PR — feito: https:\/\/github.com\/a\/b\/pull\/1/);
  assert.doesNotMatch(composeSummary({ day: [], waiting: [], prs: [], approvals: 0 }), /Você ia pedir/);
});
test('scoreboard displays prediction accuracy or not measured', () => {
  const base = { from: 0, to: 1, slack: { received: 0, answered: 0, waiting: 0, nudges: 0 }, corrections: { count: 0 }, merged: { green: 0, other: 0 } };
  assert.match(composeScoreboard({ ...base, predictions: { hits: 2, total: 3 } }), /Previsões acertadas \(7d\): \*2\* de \*3\*/);
  assert.match(composeScoreboard(base), /Previsões acertadas \(7d\): não medido/);
});
test('retro prompt requires predictions before action and scoring', () => {
  const prompt = retroPrompt('2026-11-15');
  assert.match(prompt, /prediction/i); assert.match(prompt, /before acting/i); assert.match(prompt, /yesterday/i);
});

test('morning includes only predictions done on the preceding night', () => {
  const dir = mkdtempSync(join(tmpdir(), 'predictions-night-'));
  try {
    const day = '2026-11-16';
    const earlier = new Date(2026, 10, 14, 23).getTime();
    const yesterday = new Date(2026, 10, 15, 23).getTime();
    const morning = new Date(2026, 10, 16, 6).getTime();
    for (const [text, at] of [['old', earlier], ['night', yesterday], ['morning', morning]] as const) {
      recordPrediction(dir, { day, text, status: 'predicted' }, at - 1);
      recordPrediction(dir, { day, text, status: 'done', evidence: 'https://github.com/a/b/pull/1' }, at);
    }
    assert.deepEqual(donePredictions(dir, day).map(p => p.text), ['night']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registered prediction tool feeds daily and weekly inputs', async () => {
  const { predictionsTool } = await import('../src/predictions.ts');
  const { localInputs } = await import('../src/slack-reports.ts');
  const { weekInputs } = await import('../src/scoreboard.ts');
  const dir = mkdtempSync(join(tmpdir(), 'predictions-flow-'));
  try {
    const now = Date.now();
    const today = new Date(now).toLocaleDateString('sv-SE');
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const tool = predictionsTool(() => ({ dir }));
    await tool.execute('1', { day: today, text: 'Revisar PR', status: 'predicted', evidence: 'PR aberto' });
    recordPrediction(dir, { day: today, text: 'Revisar PR', status: 'done', evidence: 'https://github.com/a/b/pull/1' }, yesterday.getTime());
    await tool.execute('2', { day: today, text: 'Revisar PR', status: 'hit', evidence: 'revisa o PR' });
    assert.equal(localInputs(dir, now, []).predictions?.[0]?.link, 'https://github.com/a/b/pull/1');
    assert.deepEqual(weekInputs(dir, now + 1000, {}).inputs.predictions, { hits: 1, total: 1 });
    await assert.rejects(tool.execute('3', { day: today, text: 'Revisar PR', status: 'miss' }));
    await assert.rejects(tool.execute('4', { day: today, text: 'sem previsão', status: 'done', evidence: 'https://github.com/a/b/pull/1' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
