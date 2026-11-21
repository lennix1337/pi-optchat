
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Memory } from '../../src/memory.ts';

const COUNT = 175_000;
const CYCLES = 3;

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const dir = mkdtempSync(join(tmpdir(), 'optchat-bench-175k-'));
try {
  mkdirSync(join(dir, 'main'));
  mkdirSync(join(dir, 'tree'));
  const log = join(dir, 'main', '2026-01-01.jsonl');
  const tree = join(dir, 'tree', '2026-01-01.jsonl');

  for (let start = 0; start < COUNT; start += 5000) {
    let rows = '';
    for (let i = start; i < Math.min(start + 5000, COUNT); i++) {
      rows += JSON.stringify({ i, kind: 'user', text: `message ${i}`, date: '2026-01-01T00:00:00.000Z' }) + '\n';
    }
    appendFileSync(log, rows);
  }

  let nodes = 0;
  for (let l = 0; COUNT / 2 ** l >= 1; l++) {
    const n = Math.floor(COUNT / 2 ** l);
    for (let start = 0; start < n; start += 5000) {
      let rows = '';
      for (let i = start; i < Math.min(start + 5000, n); i++) {
        rows += JSON.stringify({ l, i, text: `summary ${l}:${i}` }) + '\n';
      }
      appendFileSync(tree, rows);
      nodes += Math.min(5000, n - start);
    }
  }

  async function openAndClose() {
    let running = true;
    let last = performance.now();
    let longest = 0;
    const tick = () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const start = performance.now();
    const memory = await Memory.open(dir, async () => { throw new Error('unexpected compression'); }, () => {});
    await new Promise(resolve => setImmediate(resolve));
    running = false;
    const elapsed = performance.now() - start;
    if (memory.root.length !== COUNT || memory.tree.size !== nodes) {
      throw new Error(`memory contents differ: root=${memory.root.length} tree=${memory.tree.size}`);
    }
    await memory.close();
    return { elapsed, longest };
  }

  const openSamples = [];
  const blockSamples = [];
  const rssSamples = [];
  const heapSamples = [];

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    globalThis.gc?.();
    const { elapsed, longest } = await openAndClose();
    await new Promise(resolve => setTimeout(resolve, 1100));
    globalThis.gc?.();
    const after = process.memoryUsage();
    openSamples.push(elapsed);
    blockSamples.push(longest);
    rssSamples.push(after.rss / 1048576);
    heapSamples.push(after.heapUsed / 1048576);
  }

  const round1 = n => Math.round(n * 10) / 10;
  console.log(JSON.stringify([
    { metric: 'memory.175k.rss_mb', value: round1(median(rssSamples)), unit: 'MB', lowerIsBetter: true, tolerancePct: 20 },
    { metric: 'memory.175k.heap_mb', value: round1(median(heapSamples)), unit: 'MB', lowerIsBetter: true, tolerancePct: 20 },
    { metric: 'memory.175k.open_ms', value: round1(median(openSamples)), unit: 'ms', lowerIsBetter: true, tolerancePct: 35 },
    { metric: 'memory.175k.max_block_ms', value: round1(median(blockSamples)), unit: 'ms', lowerIsBetter: true, tolerancePct: 50 },
  ]));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
