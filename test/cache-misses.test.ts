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

test('a head change right after the model changed is counted as a model switch', () => {
  const r = classifyCacheMisses([
    rec(0, 0, 90000, { model: 'opus' }),
    rec(1, 90000, 12000, { model: 'opus' }),
    rec(2, 0, 100000, { model: 'sonnet' }),   // switch while warm: the other model's cache is cold
    rec(3, 100000, 500, { model: 'sonnet' }),
    rec(4, 20000, 80000, { model: 'sonnet' }),   // not a switch: same model, prefix rewritten
  ]);
  assert.equal(r.byClass.headChange.turns, 2);
  assert.equal(r.modelSwitch.turns, 1);
  assert.equal(r.modelSwitch.cacheWriteTokens, 100000);
});

test('an idle gap whose cached prefix survived (1-hour entry) is growth, not a cold miss', () => {
  const r = classifyCacheMisses([
    rec(0, 0, 90000),          // first
    rec(15, 90000, 20000),     // 15 min later the prefix was still read in full: growth
    rec(40, 0, 110000),        // 25 min later the read is gone: cold
  ]);
  assert.equal(r.byClass.cold.turns, 1);
  assert.equal(r.byClass.cold.cacheWriteTokens, 110000);
  assert.equal(r.byClass.growth.turns, 1);
});

test('head changes are attributed to the cause the cache diagnostics recorded at the same moment', () => {
  const at = (minute: number, extra: object) => ({ date: new Date(Date.UTC(2026, 9, 31, 12, minute, 5)).toISOString(), ...extra });
  const r = classifyCacheMisses([
    rec(0, 90000, 90000), rec(1, 30000, 70000),  // head change: model part changed
    rec(2, 90000, 500), rec(3, 30000, 60000),    // head change: only an early view block changed
    rec(6, 90000, 500), rec(8, 30000, 50000),    // head change: no diagnostic within two minutes
  ], { diagnostics: [
    at(1, { headChanged: true, headParts: ['model'] }),
    at(3, { headChanged: false, changedAt: 4 }),
    at(20, { headChanged: true, headParts: ['tools'] }),
  ] });
  assert.deepEqual(Object.fromEntries(Object.entries(r.headCause).map(([k, v]) => [k, v.turns])), { model: 1, earlyView: 1, unmatched: 1 });
  assert.equal(r.headCause.model.cacheWriteTokens, 70000);
});

test('without diagnostics no cause is claimed', () => {
  const r = classifyCacheMisses([rec(0, 0, 90000), rec(1, 30000, 70000)]);
  assert.deepEqual(r.headCause, {});
});

test('afterIdle reports the first call after an idle gap per day, with its median write (the cost a wake pays)', () => {
  const day = (d: number, minute: number, read: number, write: number) => rec(minute, read, write, { date: new Date(Date.UTC(2026, 9, d, 12, minute)).toISOString() });
  const r = classifyCacheMisses([
    day(30, 0, 0, 30000),          // first call ever: idle by definition
    day(30, 1, 30000, 500),        // 1 min later: not idle
    day(30, 40, 0, 20000),         // 39 min gap: idle call
    day(31, 0, 0, 10000),          // next day, idle call
    day(31, 3, 10000, 400),
  ]);
  assert.deepEqual(r.afterIdle['2026-10-30'], { turns: 2, cacheWriteUsd: 0.05, cacheWriteTokens: 50000, medianWriteTokens: 25000 });
  assert.deepEqual(r.afterIdle['2026-10-31'], { turns: 1, cacheWriteUsd: 0.01, cacheWriteTokens: 10000, medianWriteTokens: 10000 });
});
