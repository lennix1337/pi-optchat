import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { graphDot, renderGraph } from '../src/channels/home-graph.ts';
import { homeGraph } from '../../src/home-dashboard.ts';

test('DOT describes session, workers, shells and their PR edges safely', () => {
  const graph = homeGraph({ prs: [{ repo: 'org/repo', number: 12, title: 'Fix', url: 'https://example.test/pr', checks: 'pendentes' }], commitments: [], jobs: [], workers: [
    { id: 'w', kind: 'worker', model: '', label: 'Review "quoted"', started: 0, target: { repo: 'org/repo', pr: 12 } },
    { id: 's', kind: 'shell', model: '', label: 'Test', started: 0 },
  ] }, 'working');
  const dot = graphDot(graph);
  assert.match(dot, /Sessão/);
  assert.match(dot, /Review \\\"quoted\\\"/);
  assert.match(dot, /org\/repo#12/);
  assert.match(dot, /session -> worker0/);
  assert.match(dot, /session -> worker1/);
  assert.match(dot, /worker0 -> pr0/);
});

test('rendered PNG from dot', { skip: spawnSync('dot', ['-V']).status !== 0 }, async () => {
  const graph = { nodes: [{ id: 'session', label: 'Sessão' }], edges: [] };
  const png = await renderGraph(graph, 'dot');
  assert.deepEqual(png?.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test('unavailable or failing dot falls back', async () => {
  const graph = { nodes: [{ id: 'session', label: 'Sessão' }], edges: [] };
  assert.equal(await renderGraph(graph, '/no/such/dot'), undefined);
  assert.equal(await renderGraph(graph, process.execPath), undefined);
});
