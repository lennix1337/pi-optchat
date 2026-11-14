import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStallWatch } from '../src/loop-stalls.ts';
import { heapReport } from '../src/heap-report.ts';

const clock = () => { let t = 1000; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

test('a tick that arrives on time records nothing; a late one records the blocked time', () => {
  const c = clock(), watch = createStallWatch(c.now, () => Date.parse('2026-11-13T12:00:00Z'));
  c.advance(100); watch.tick();
  assert.deepEqual(watch.stalls(), []);
  c.advance(10_100); watch.tick();
  assert.deepEqual(watch.stalls(), [{ at: '2026-11-13T12:00:00.000Z', blockedMs: 10_000, gcMs: 0, gcKind: null }]);
});

test('a garbage collection inside the stall window is named as its cause; one outside is not', () => {
  const c = clock(), watch = createStallWatch(c.now);
  watch.noteGc(1000 - 500, 50, 2); // before the stall window
  watch.noteGc(1300, 400, 2);
  watch.noteGc(1750, 30, 1);
  c.advance(1100); watch.tick();
  const [stall] = watch.stalls();
  assert.equal(stall.blockedMs, 1000);
  assert.equal(stall.gcMs, 430);
  assert.equal(stall.gcKind, 'mark-sweep-compact');
});

test('only the last 20 stalls are kept', () => {
  const c = clock(), watch = createStallWatch(c.now);
  for (let i = 0; i < 25; i++) { c.advance(1000); watch.tick(); }
  assert.equal(watch.stalls().length, 20);
});

test('heap_report carries the stall list inside eventLoop', async () => {
  const report = await heapReport({}, {});
  assert.ok(Array.isArray((report.eventLoop as { stalls: unknown }).stalls));
});

test('a stall names the tools that were running (or ended) inside its window; none means the block was outside any tool', () => {
  const c = clock(), watch = createStallWatch(c.now);
  const early = watch.begin('tool:read'); c.advance(100); early(); // ended before the stall window
  watch.tick();
  const bash = watch.begin('tool:bash'); // still running when the loop wakes up
  const grep = watch.begin('tool:grep'); c.advance(500); grep();
  c.advance(700); watch.tick();
  assert.deepEqual(watch.stalls()[0].during, ['tool:bash', 'tool:grep']);
  bash();
  c.advance(1100); watch.tick();
  assert.equal(watch.stalls()[1].during, undefined, 'a stall with no tool in flight carries no tool names');
});
