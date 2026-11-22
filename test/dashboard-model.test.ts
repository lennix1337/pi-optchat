import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboard } from '../src/dashboard-model.ts';
import { homeDashboard, homeShell, shellTarget } from '../src/home-dashboard.ts';
import { renderWork } from '../src/home-items.ts';

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

test('home shell projection never includes the raw command', () => {
  const secret = 'unset -v EXAMPLE_SECRET_TOKEN';
  const shell = { id: 's1', command: secret, started: 0 };
  const unnamed = homeShell(shell, 60_000);
  const named = homeShell({ ...shell, label: 'Executando testes' }, 60_000);
  const repeated = homeShell({ ...shell, label: secret }, 60_000);
  assert.equal(repeated.job, 'Comando em segundo plano · há 1 min');
  assert.equal(unnamed.job, 'Comando em segundo plano · há 1 min');
  assert.equal(named.job, 'Executando testes · há 1 min');
  const work = { prs: [], commitments: [], jobs: [unnamed.job, named.job], workers: [unnamed.worker, named.worker] };
  const visible = [renderWork(work), ...homeDashboard(work, [], 'working', undefined, 60_000).team].join('\n');
  assert.match(visible, /Comando em segundo plano/);
  assert.match(visible, /Executando testes/);
  assert.doesNotMatch(visible, /EXAMPLE_SECRET_TOKEN|unset -v/);
});

test('agy shell target requires an explicit repo in its label or flag', () => {
  assert.deepEqual(shellTarget('agy: atualização', 'agy --repo org/repo'), { repo: 'org/repo' });
  assert.deepEqual(shellTarget('agy: repo: org/repo#42', 'agy run'), { repo: 'org/repo', pr: 42 });
  assert.deepEqual(shellTarget('agy: repo#42', 'agy run'), { repo: 'repo', pr: 42 });
  assert.equal(shellTarget('agy: #42', 'agy run'), undefined);
  assert.equal(shellTarget('build', 'npm test --repo org/repo'), undefined);
});
