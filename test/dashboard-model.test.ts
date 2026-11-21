import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboard, dashboardMermaid } from '../src/dashboard-model.ts';

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

test('mermaid uses only explicit links and escapes label syntax', () => {
  const model = dashboard({ now: 0, pi: { state: 'idle' }, workers: [
    { id: 'x', kind: 'agy', model: 'Neon', label: 'a"] --> HACK["b', started: 1, target: { repo: 'org/repo', pr: 4 } },
    { id: 'y', kind: 'worker', model: 'm', label: 'unlinked', started: 0 },
  ], prs: [], waiting: [], deliveries: [] });
  const diagram = dashboardMermaid(model);
  assert.match(diagram, /root --> w0/);
  assert.match(diagram, /w0 --> target0/);
  assert.doesNotMatch(diagram, /w1 --> target/);
  assert.doesNotMatch(diagram, /a"\] --> HACK\["b/);
  assert.equal(model.workers[0]!.ageMs, 0);
});

test('empty dashboard still has a valid root graph', () => {
  assert.equal(dashboardMermaid(dashboard({ now: 0, pi: { state: 'idle' }, workers: [], prs: [], waiting: [], deliveries: [] })), 'flowchart LR\n  root["OptChat"]');
});
