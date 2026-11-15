import { setImmediate as yieldLoop } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

/** Runs the same incremental work synchronously or in short event-loop slices. */
export function runSync(work: Generator<void, void>) { while (!work.next().done) {} }
export function* sortSteps<T>(values: T[], compare: (a: T, b: T) => number): Generator<void, void> {
  let sorted = true;
  for (let i = 1; i < values.length; i++) { if (compare(values[i - 1], values[i]) > 0) sorted = false; yield; }
  if (sorted) return;
  const scratch = new Array<T>(values.length);
  for (let width = 1; width < values.length; width *= 2) {
    for (let start = 0; start < values.length; start += width * 2) {
      const middle = Math.min(start + width, values.length), end = Math.min(start + width * 2, values.length);
      let left = start, right = middle;
      for (let i = start; i < end; i++) {
        scratch[i] = left < middle && (right >= end || compare(values[left], values[right]) <= 0) ? values[left++] : values[right++];
        yield;
      }
      for (let i = start; i < end; i++) { values[i] = scratch[i]; yield; }
    }
  }
}
export async function runSliced(work: Generator<void, void>) {
  let started = performance.now(), steps = 0;
  while (!work.next().done) {
    if (++steps % 256 === 0 && performance.now() - started >= 15) {
      await yieldLoop();
      started = performance.now();
    }
  }
}
