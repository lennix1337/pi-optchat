import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heapGrowth, heapGrowthLine, recordHeapSample, rssLine, type HeapSample } from '../src/heap-trend.ts';

const H = 3_600_000;

const series = (hours: number, rate: number, { start = 1470, everyH = 0.5, afterGc = false } = {}): HeapSample[] =>
  Array.from({ length: Math.floor(hours / everyH) + 1 }, (_, i) => ({ at: i * everyH * H, heapUsedMb: start + rate * i * everyH, afterGc }));

test('a flat heap gives a growth near zero and no radar line', () => {
  const growth = heapGrowth(series(6, 0), 6 * H);
  assert.ok(growth && Math.abs(growth.mbPerHour) < 1e-6);
  assert.equal(heapGrowthLine(growth), undefined);
});

test('+110 MB/h over 6 h gives the line with the slope, span and fitted ends', () => {
  const growth = heapGrowth(series(6, 110), 6 * H);
  assert.ok(growth);
  assert.ok(Math.abs(growth.mbPerHour - 110) < 1e-6);
  assert.equal(growth.spanH, 6);
  assert.equal(heapGrowthLine(growth), 'Pi heap grows ~110 MB/h over 6 h (1470 -> 2130 MB)');
});

test('a slope under the threshold gives no line; the threshold is adjustable', () => {
  const growth = heapGrowth(series(6, 30), 6 * H);
  assert.equal(heapGrowthLine(growth), undefined);
  assert.match(heapGrowthLine(growth, { thresholdMbPerHour: 20 }) ?? '', /^Pi heap grows ~30 MB\/h/);
});

test('a falling heap gives no line', () => {
  assert.equal(heapGrowthLine(heapGrowth(series(6, -80), 6 * H)), undefined);
});

test('too few points or too short a span is undefined', () => {
  assert.equal(heapGrowth(series(6, 110, { everyH: 2 }).slice(0, 3), 6 * H), undefined, '3 points');
  assert.equal(heapGrowth(series(1.5, 110), 1.5 * H), undefined, '1.5 h span');
  assert.ok(heapGrowth(series(2, 110), 2 * H), 'exactly the minimum span still counts');
  assert.equal(heapGrowth(series(6, 110), 6 * H, { minPoints: 20 }), undefined);
  assert.equal(heapGrowth([], 0), undefined);
  assert.equal(heapGrowthLine(undefined), undefined);
});

test('a sawtooth of unforced samples does not hide a rise seen after collections', () => {
  const rising = series(6, 110, { afterGc: true });
  const noise: HeapSample[] = series(6, 0, { start: 1470 + 800 }).map((sample, i) => ({ ...sample, at: sample.at + 1, heapUsedMb: sample.heapUsedMb - (i % 2 ? 700 : 0) }));
  const growth = heapGrowth([...rising, ...noise], 6 * H);
  assert.ok(growth && Math.abs(growth.mbPerHour - 110) < 1e-6);
});

test('samples after `now` are ignored', () => {
  assert.equal(heapGrowth(series(6, 110), 1 * H), undefined);
});

test('recording keeps the last 24 h only, relative to the new sample', () => {
  const old = [{ at: 0, heapUsedMb: 1, afterGc: false }, { at: 10 * H, heapUsedMb: 2, afterGc: false }];
  const kept = recordHeapSample(old, { at: 25 * H, heapUsedMb: 3, afterGc: false });
  assert.deepEqual(kept.map(sample => sample.heapUsedMb), [2, 3]);
  assert.deepEqual(recordHeapSample(old, { at: 25 * H, heapUsedMb: 3, afterGc: true }, 100 * H).length, 3, 'keepMs is adjustable');
  assert.equal(old.length, 2, 'the input list is not changed');
});

test('rssLine: names the Pi RSS once the last three samples all sit above the goal, and stays quiet otherwise', () => {
  const at = (rssMb: number | undefined, i: number): HeapSample => ({ at: i * H, heapUsedMb: 260, afterGc: false, ...rssMb === undefined ? {} : { rssMb } });
  assert.equal(rssLine([at(713, 0), at(720, 1), at(705, 2)]), 'Pi RSS 705 MB, above the 500 MB goal in the last 3 samples');
  const split = { ...at(705, 2), heapTotalMb: 366, externalMb: 30 };
  assert.equal(rssLine([at(713, 0), at(720, 1), split]), 'Pi RSS 705 MB, above the 500 MB goal in the last 3 samples (V8 heap 366 MB, external 30 MB, other native 309 MB)', 'the newest sample splits the RSS into heap, external and other native');
  assert.equal(rssLine([at(713, 0), at(480, 1), at(705, 2)]), undefined, 'one sample under the goal breaks the stretch');
  assert.equal(rssLine([at(713, 0), at(720, 1)]), undefined, 'two samples are not enough');
  assert.equal(rssLine([at(undefined, 0), at(undefined, 1), at(undefined, 2)]), undefined, 'samples from before the RSS watch carry no RSS');
  assert.equal(rssLine([at(600, 0), at(610, 1), at(620, 2)], { limitMb: 650 }), undefined, 'the goal is adjustable');
});
