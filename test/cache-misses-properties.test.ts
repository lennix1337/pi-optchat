import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCacheMisses, SMALL_WRITE_TOKENS, type UsageRecord, type MissClass } from '../src/cache-misses.ts';

// Seeded generator: a failing case reproduces from its seed.
const rng = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const CASES = 200;
// Summing dollars in another order differs in the last bit; compare to the micro-dollar.
const rounded = (value: unknown) => JSON.parse(JSON.stringify(value), (_k, v) => typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v);
const CLASSES: MissClass[] = ['small', 'first', 'cold', 'headChange', 'growth'];

function records(seed: number): UsageRecord[] {
  const next = rng(seed), sessions = ['a', 'b', 'c'], models = ['opus', 'sonnet'], out: UsageRecord[] = [];
  let minute = 0;
  for (let i = 0, n = 1 + Math.floor(next() * 40); i < n; i++) {
    minute += Math.floor(next() * 30);
    const write = Math.floor(next() * 40000), read = Math.floor(next() * 200000);
    out.push({
      date: new Date(Date.UTC(2026, 10, 1 + Math.floor(minute / 1440), 0, minute % 1440)).toISOString(),
      role: next() < 0.9 ? 'main' : 'sub', model: models[Math.floor(next() * 2)], session: sessions[Math.floor(next() * 3)],
      usage: { cacheRead: read, cacheWrite: write, cost: { cacheWrite: write / 1e6, total: (write + read) / 1e6 } },
    });
  }
  return out;
}

test('every main turn lands in exactly one class: turns, tokens and dollars are conserved', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const rs = records(seed), main = rs.filter(r => r.role === 'main'), report = classifyCacheMisses(rs);
    const sum = (f: (b: { turns: number; cacheWriteUsd: number; cacheWriteTokens: number }) => number) => CLASSES.reduce((acc, c) => acc + f(report.byClass[c]), 0);
    assert.equal(sum(b => b.turns), main.length, `seed ${seed}: turns`);
    assert.equal(sum(b => b.cacheWriteTokens), main.reduce((a, r) => a + r.usage!.cacheWrite, 0), `seed ${seed}: tokens`);
    assert.ok(Math.abs(sum(b => b.cacheWriteUsd) - main.reduce((a, r) => a + r.usage!.cost.cacheWrite, 0)) < 1e-9, `seed ${seed}: dollars`);
    assert.ok(Math.abs(report.totalUsd - main.reduce((a, r) => a + r.usage!.cost.total, 0)) < 1e-9, `seed ${seed}: total`);
  }
});

test('small writes are small; byDay and the model switch only subdivide head changes', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const rs = records(seed), report = classifyCacheMisses(rs), head = report.byClass.headChange;
    const smalls = rs.filter(r => r.role === 'main' && r.usage!.cacheWrite < SMALL_WRITE_TOKENS).length;
    assert.equal(report.byClass.small.turns, smalls, `seed ${seed}: small`);
    assert.equal(Object.values(report.byDay).reduce((a, b) => a + b.turns, 0), head.turns, `seed ${seed}: byDay`);
    assert.ok(report.modelSwitch.turns <= head.turns && report.modelSwitch.cacheWriteTokens <= head.cacheWriteTokens, `seed ${seed}: modelSwitch`);
    assert.ok(report.byClass.first.turns <= 3, `seed ${seed}: at most one first write per session`);
  }
});

test('sessions are independent: interleaving or reordering them across sessions changes nothing', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const rs = records(seed), next = rng(seed + 9999);
    // Stable shuffle across sessions: pick the next record from a random session, keeping each session's own order.
    const queues = new Map<string, UsageRecord[]>();
    for (const r of rs) (queues.get(r.session!) ?? queues.set(r.session!, []).get(r.session!)!).push(r);
    const shuffled: UsageRecord[] = [];
    while ([...queues.values()].some(q => q.length)) {
      const live = [...queues.values()].filter(q => q.length);
      shuffled.push(live[Math.floor(next() * live.length)].shift()!);
    }
    assert.deepEqual(rounded(classifyCacheMisses(shuffled)), rounded(classifyCacheMisses(rs)), `seed ${seed}`);
  }
});
