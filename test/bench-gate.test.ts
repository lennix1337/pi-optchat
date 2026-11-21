import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildUpdatedBaseline,
  compareMetrics,
  median,
  normalizePluginOutput,
  splitBaseline,
  type BaselineMap,
  type MetricsMap,
} from '../scripts/bench-gate.ts';

test('comparator detects regression beyond tolerance for lowerIsBetter and higherIsBetter', () => {
  const baseline: BaselineMap = {
    'turn_start.p50_ms': { value: 100, unit: 'ms', lowerIsBetter: true, tolerancePct: 10 },
    'context.saved_pct': { value: 90, unit: 'percent', lowerIsBetter: false, tolerancePct: 5 },
    'prompt_cache.prefix_changes': { value: 0, unit: 'count', lowerIsBetter: true, tolerancePct: 0 },
  };
  const current: MetricsMap = {
    'turn_start.p50_ms': { value: 115, unit: 'ms', lowerIsBetter: true },
    'context.saved_pct': { value: 84, unit: 'percent', lowerIsBetter: false },
    'prompt_cache.prefix_changes': { value: 1, unit: 'count', lowerIsBetter: true },
  };

  const result = compareMetrics(current, baseline);
  assert.equal(result.passed, false);
  assert.deepEqual(result.regressed.map(r => r.metric), [
    'context.saved_pct',
    'prompt_cache.prefix_changes',
    'turn_start.p50_ms',
  ]);
});

test('comparator accepts improvements and changes within tolerance', () => {
  const baseline: BaselineMap = {
    'memory.rss_mb': { value: 250, unit: 'MB', lowerIsBetter: true, tolerancePct: 10 },
    'context.saved_pct': { value: 80, unit: 'percent', lowerIsBetter: false, tolerancePct: 5 },
    'prefix.bytes': { value: 1000, unit: 'bytes', lowerIsBetter: true, tolerancePct: 5 },
  };
  const current: MetricsMap = {
    'memory.rss_mb': { value: 200, unit: 'MB', lowerIsBetter: true },
    'context.saved_pct': { value: 95, unit: 'percent', lowerIsBetter: false },
    'prefix.bytes': { value: 1040, unit: 'bytes', lowerIsBetter: true },
  };

  const result = compareMetrics(current, baseline);
  assert.equal(result.passed, true);
  assert.equal(result.regressed.length, 0);
  assert.deepEqual(result.improved.map(i => i.metric), ['context.saved_pct', 'memory.rss_mb']);
  assert.equal(result.comparisons.find(c => c.metric === 'prefix.bytes')?.status, 'ok');
});

test('comparator allows new metrics without an existing baseline', () => {
  const baseline: BaselineMap = {
    'prefix.bytes': { value: 1000, unit: 'bytes', lowerIsBetter: true, tolerancePct: 5 },
  };
  const current: MetricsMap = {
    'prefix.bytes': { value: 1000, unit: 'bytes', lowerIsBetter: true },
    'openhuman.output_query_tokens': { value: 320, unit: 'tokens', lowerIsBetter: true },
  };

  const result = compareMetrics(current, baseline);
  assert.equal(result.passed, true);
  assert.deepEqual(result.added.map(a => a.metric), ['openhuman.output_query_tokens']);
  assert.equal(result.added[0]?.status, 'new');
});

test('normalizePluginOutput supports single object, array, and keyed map', () => {
  const single = normalizePluginOutput({ metric: 'a.ms', value: 12, unit: 'ms', lowerIsBetter: true });
  assert.equal(single['a.ms']?.value, 12);

  const arr = normalizePluginOutput([
    { metric: 'b.bytes', value: 42, unit: 'bytes', lowerIsBetter: true },
  ]);
  assert.equal(arr['b.bytes']?.value, 42);

  const map = normalizePluginOutput({
    'c.pct': { value: 99, unit: 'percent', lowerIsBetter: false },
  });
  assert.equal(map['c.pct']?.lowerIsBetter, false);
});

test('median and buildUpdatedBaseline preserve tolerances and compute odd/even medians', () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([40, 10, 20, 30]), 25);

  const updated = buildUpdatedBaseline(
    {
      'a.ms': { value: 55, unit: 'ms', lowerIsBetter: true, tolerancePct: 10 },
      'b.bytes': { value: 120, unit: 'bytes', lowerIsBetter: true },
    },
    {
      'a.ms': { value: 60, unit: 'ms', lowerIsBetter: true, tolerancePct: 25, runs: 3 },
    },
  );
  assert.equal(updated['a.ms']?.tolerancePct, 25);
  assert.equal(updated['a.ms']?.runs, 3);
  assert.equal(updated['b.bytes']?.tolerancePct, 5);
});

test('timings and memory baseline per machine; sizes and counts stay shared', () => {
  const { shared, machine } = splitBaseline({
    'a.ms': { value: 1, unit: 'ms', lowerIsBetter: true },
    'b.heap': { value: 5, unit: 'MB', lowerIsBetter: true },
    'c.bytes': { value: 9, unit: 'bytes', lowerIsBetter: true },
    'd.count': { value: 0, unit: 'count', lowerIsBetter: true },
  });
  assert.deepEqual(Object.keys(shared), ['c.bytes', 'd.count']);
  assert.deepEqual(Object.keys(machine), ['a.ms', 'b.heap']);

  const result = compareMetrics({ 'a.ms': { value: 99, unit: 'ms', lowerIsBetter: true } }, shared);
  assert.equal(result.passed, true);
  assert.equal(result.added[0]?.metric, 'a.ms');
});
