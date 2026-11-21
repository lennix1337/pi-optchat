import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboard } from '../src/dashboard-model.ts';
import { homeDashboard, shellTarget } from '../src/home-dashboard.ts';

test('dashboard is a detached, panel-independent snapshot', () => {
  const workers = [{ id: 'w1', kind: 'agy', model: 'Neon', label: 'GX18MCP', started: 1000, target: { repo: 'org/gx', pr: 42 } }];
  const input = { now: 361000, pi: { state: 'working', model: 'model' }, workers, prs: [{ repo: 'org/gx', number: 42, title: 'Fix', url: 'https://github.com/org/gx/pull/42', checks: 'pendentes' as const }], waiting: ['Aprovar'], deliveries: ['Feito'] };
  const result = dashboard(input);
  workers[0]!.label = 'changed';
  assert.equal(result.workers[0]!.label, 'GX18MCP');
  assert.equal(result.workers[0]!.ageMs, 360000);
  assert.equal(result.prs[0]!.checks, 'pendentes');
  assert.deepEqual(result.waiting, ['Aprovar']);
  assert.deepEqual(result.deliveries, ['Feito']);
});

test('team lines show only an explicitly supplied repository and PR', () => {
  const workers = [
    { id: '1', kind: 'agy', model: 'Neon', label: 'GX18MCP', started: 0, target: { repo: 'GX18MCP', pr: 42 } },
    { id: '2', kind: 'shell', model: '', label: 'sem alvo', started: 0 },
  ];
  const result = homeDashboard({ workers, prs: [], commitments: [], jobs: [] }, [], 'working', undefined, 360000);
  assert.equal(result.team[0], 'agy · Neon · GX18MCP → GX18MCP#42 · há 6 min');
  assert.equal(result.team[1], 'shell · sem alvo · há 6 min');
});

test('agy shell target requires an explicit repo in its label or flag', () => {
  assert.deepEqual(shellTarget('agy: atualização', 'agy --repo org/repo'), { repo: 'org/repo' });
  assert.deepEqual(shellTarget('agy: repo: org/repo#42', 'agy run'), { repo: 'org/repo', pr: 42 });
  assert.deepEqual(shellTarget('agy: repo#42', 'agy run'), { repo: 'repo', pr: 42 });
  assert.equal(shellTarget('agy: #42', 'agy run'), undefined);
  assert.equal(shellTarget('build', 'npm test --repo org/repo'), undefined);
});
