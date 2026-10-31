import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCacheMisses, type UsageRecord } from '../src/cache-misses.ts';

const rec = (minute: number, read: number, write: number, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  date: new Date(Date.UTC(2026, 9, 31, 12, minute)).toISOString(), role: 'main', model: 'm', session: 's',
  usage: { cacheRead: read, cacheWrite: write, cost: { cacheWrite: write / 1e6, total: (write + read) / 1e6 } }, ...extra,
});

test('separates growth, head change, cold and first writes', () => {
  const r = classifyCacheMisses([
    rec(0, 0, 90000),         // first
    rec(1, 90000, 12000),     // growth: prefix kept
    rec(2, 30000, 70000),     // headChange: read fell from 90000 to 30000 while warm
    rec(20, 0, 60000),        // cold: 18 min gap
    rec(21, 60000, 500),      // small
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(r.byClass).map(([k, v]) => [k, v.turns])),
    { small: 1, first: 1, cold: 1, headChange: 1, growth: 1 });
  assert.equal(r.byClass.headChange.cacheWriteTokens, 70000);
  assert.equal(Object.keys(r.byDay).length, 1);
});

test('a write while the prefix is kept is growth, never a head change', () => {
  const r = classifyCacheMisses([rec(0, 80000, 9000), rec(1, 85000, 9000), rec(2, 90000, 9000)]);
  assert.equal(r.byClass.headChange.turns, 0);
  assert.equal(r.byClass.growth.turns, 2);
});

test('only main turns of the requested model are counted', () => {
  const r = classifyCacheMisses([rec(0, 0, 90000), rec(1, 0, 90000, { role: 'compactor' }), rec(2, 0, 90000, { model: 'other' })], { model: 'm' });
  assert.equal(r.byClass.first.turns, 1);
});
