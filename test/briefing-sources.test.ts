import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activityLines, githubActivity, harnessCost } from '../src/briefing-sources.ts';
import { composeSummary } from '../src/slack-reports.ts';

const now = Date.parse('2026-11-02T10:00:00Z');
const recent = '2026-11-02T03:00:00Z', old = '2026-10-30T03:00:00Z';
const node = (o: object) => ({ __typename: 'PullRequest', repository: { nameWithOwner: 'lennix1337/ripwire' }, url: 'https://github.com/x/pull/1', ...o });

function fakeGh(fail: string[] = []) {
  return async (args: string[]) => {
    const q = args.find(a => a.startsWith('q=')) ?? '';
    if (args.includes('notifications')) {
      if (fail.includes('notifications')) throw new Error('HTTP 502');
      return JSON.stringify([{ reason: 'mention', subject: { title: 'Bug no deploy' }, repository: { full_name: 'tecnologia-ai/dentai' } },
        { reason: 'ci_activity', subject: { title: 'CI' }, repository: { full_name: 'a/b' } },
        { reason: 'comment', subject: { title: 'PR comentado' }, repository: { full_name: 'lennix1337/ripwire' } },
        { reason: 'mention', subject: { title: 'Fork merge' }, repository: { full_name: 'lennix1337/ripwire' } },
        { reason: 'state_change', subject: { title: 'Velho' }, repository: { full_name: 'a/b' } }]);
    }
    if (fail.some(f => q.includes(f))) throw new Error('rate limited');
    const nodes = q.includes('closed:') ? [node({ number: 471, title: 'Fork merge', state: 'MERGED' }), node({ __typename: 'Issue', number: 9, title: 'Issue X', state: 'CLOSED' })]
      : q.includes('review-requested') ? [node({ number: 5, title: 'Revise isso', state: 'OPEN' })]
      : [node({ number: 7, title: 'PR comentado', state: 'OPEN', comments: { nodes: [{ author: { login: 'maint' }, createdAt: recent }, { author: { login: 'me' }, createdAt: recent }, { author: { login: 'old' }, createdAt: old }] }, reviews: { nodes: [{ author: { login: 'ci[bot]' }, createdAt: recent }] } }),
        node({ number: 8, title: 'Quieto', state: 'OPEN', comments: { nodes: [] }, reviews: { nodes: [] } })];
    return JSON.stringify({ data: { search: { nodes } } });
  };
}

test('the briefing sees closed work, review requests, new comments by others and mentions', async () => {
  const a = await githubActivity(fakeGh(), now, 'me');
  assert.deepEqual(a.failed, []);
  assert.deepEqual(a.closed.map(c => [c.number, c.merged, c.kind]), [[471, true, 'pr'], [9, false, 'issue']]);
  assert.deepEqual(a.comments.map(c => [c.number, c.who]), [[7, ['maint']]]);
  assert.deepEqual(a.mentions.map(m => m.title), ['Bug no deploy'], 'CI and state noise, and threads already listed or closed, are not repeated');
  const lines = activityLines(a);
  assert.match(lines.needs.join('\n'), /Revisão pedida.*ripwire#5/);
  assert.match(lines.needs.join('\n'), /maint comentou.*ripwire#7/);
  assert.match(lines.closed.join('\n'), /ripwire \(2\)[\s\S]*🟣.*#471/);
});

test('a GitHub source that fails is named, the others still arrive', async () => {
  const a = await githubActivity(fakeGh(['notifications', 'review-requested']), now, 'me');
  assert.deepEqual(a.failed.sort(), ['GitHub notificações', 'GitHub revisões']);
  assert.equal(a.closed.length, 2);
});

test('harness cost sums the last 24h by model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cost-'));
  const row = (date: string, model: string, total: number) => JSON.stringify({ date, model, usage: { cost: { total } } });
  writeFileSync(join(dir, 'usage.jsonl'), [row(old, 'claude-opus-5-5', 50), row(recent, 'claude-opus-5-5', 3), row(recent, 'claude-sonnet-5-5', 1.5), '{torn'].join('\n'));
  assert.equal(harnessCost(dir, now), 'US$4.50 nas últimas 24h (opus-5-5 US$3.00, sonnet-5-5 US$1.50)');
  assert.equal(harnessCost(join(dir, 'none'), now), undefined);
});

test('the summary opens with what needs him, then the plan, closed work, cost and missing sources', () => {
  const text = composeSummary({ day: [], waiting: [], prs: [], approvals: 1,
    github: { closed: [{ repo: 'a/ripwire', number: 471, title: 'Fork', url: 'u', merged: true, kind: 'pr' }], reviews: [], mentions: [],
      comments: [{ repo: 'a/ripwire', number: 7, title: 'T', url: 'u', who: ['maint'] }], failed: ['GitHub notificações'] }, cost: 'US$4.50 nas últimas 24h' });
  const need = text.indexOf('*Precisa de você hoje*'), plan = text.indexOf('*Plano do dia*'), closed = text.indexOf('*Fechado nas últimas 24h*');
  assert.ok(need > 0 && plan > need && closed > plan, text);
  assert.match(text, /maint comentou/);
  assert.match(text, /\*Custo do harness\*\n• US\$4\.50/);
  assert.match(text, /Fontes incompletas: GitHub notificações/);
});
