import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyScoreboard, classifyIntervention, scoreboardLine } from '../src/intervention-scoreboard.ts';

const entry = (timestamp: string, text: string) => ({ type: 'message', timestamp, message: { role: 'user', content: [{ type: 'text', text }] } });
const session = (entries: ReturnType<typeof entry>[]) => [{ type: 'custom', customType: 'optchat.profile', data: { name: 'swlucas05' } }, ...entries];

test('counts only operator messages in OptChat and merged PRs in Brasilia calendar days', () => {
  const now = Date.parse('2026-11-20T15:00:00Z');
  const sessions = [session([
    entry('2026-11-20T12:00:00Z', '[Slack] Não, isso está errado'),
    entry('2026-11-20T13:00:00Z', 'Pode fazer'),
    entry('2026-11-20T14:00:00Z', 'Por que falhou?'),
    entry('2026-11-20T14:01:00Z', '[gitwatch] PR fechado'),
    entry('2026-11-20T14:02:00Z', '[shell 9] done'),
    entry('2026-11-20T14:03:00Z', '[OptChat wake] heartbeat'),
    entry('2026-11-20T14:04:00Z', '[Slack #harness] not a DM'),
    entry('2026-11-20T14:05:00Z', '[Slack] (aprovação) machine notice'),
    entry('2026-11-20T02:00:00Z', 'uma mensagem ontem'),
    entry('2026-11-13T02:00:00Z', 'fora da semana'),
  ]), [entry('2026-11-20T12:00:00Z', 'worker prompt')]];
  const prs = [{ mergedAt: '2026-11-20T11:00:00Z' }, { mergedAt: '2026-11-20T02:00:00Z' }];
  const result = tallyScoreboard(sessions, prs, now);
  assert.equal(result.days.length, 7);
  assert.deepEqual(result.days.at(-1), { date: '2026-11-20', interventions: 3, mergedPRs: 1, perPR: 3 });
  assert.deepEqual(result.week, { interventions: 4, mergedPRs: 2, perPR: 2, kinds: { corrections: 1, approvals: 1, questions: 1, other: 1 } });
  assert.match(scoreboardLine(result), /hoje.*3.*1.*3/);
});

test('simple classification has precedence and zero PRs are undefined, not zero', () => {
  assert.equal(classifyIntervention('Não, por que fez isso?'), 'corrections');
  assert.equal(classifyIntervention('Sim, pode seguir'), 'approvals');
  assert.equal(classifyIntervention('Por que parou'), 'questions');
  assert.equal(classifyIntervention('Faça o relatório'), 'other');
  const result = tallyScoreboard([session([entry('2026-11-20T12:00:00Z', 'Faça')])], [], Date.parse('2026-11-20T15:00:00Z'));
  assert.equal(result.week.perPR, null);
  assert.match(scoreboardLine(result), /sem PR/i);
});
