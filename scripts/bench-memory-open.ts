// Disposable synthetic memory-open/reload probe. Run with node --expose-gc --experimental-transform-types scripts/bench-memory-open.ts [cycles] [max-block-ms].
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Memory } from '../src/memory.ts';

const count = 150_000, cycles = Number(process.argv[2] ?? 4), limit = Number(process.argv[3] ?? Infinity);
const dir = mkdtempSync(join(tmpdir(), 'optchat-memory-bench-'));
try {
  mkdirSync(join(dir, 'main')); mkdirSync(join(dir, 'tree'));
  const log = join(dir, 'main', '2026-01-01.jsonl'), tree = join(dir, 'tree', '2026-01-01.jsonl');
  for (let start = 0; start < count; start += 5000) {
    let rows = '';
    for (let i = start; i < Math.min(start + 5000, count); i++) rows += JSON.stringify({ i, kind: 'user', text: `message ${i}`, date: '2026-01-01T00:00:00.000Z' }) + '\n';
    appendFileSync(log, rows);
  }
  let nodes = 0;
  for (let l = 0; count / 2 ** l >= 1; l++) {
    const n = Math.floor(count / 2 ** l);
    for (let start = 0; start < n; start += 5000) {
      let rows = '';
      for (let i = start; i < Math.min(start + 5000, n); i++) rows += JSON.stringify({ l, i, text: `summary ${l}:${i}` }) + '\n';
      appendFileSync(tree, rows); nodes += Math.min(5000, n - start);
    }
  }
  console.log(`synthetic lines=${count} tree=${nodes} cycles=${cycles}`);
  async function openAndClose() {
    let running = true, last = performance.now(), longest = 0;
    const tick = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; if (running) setImmediate(tick); };
    setImmediate(tick);
    const start = performance.now();
    const memory = await Memory.open(dir, async () => { throw new Error('unexpected compression'); }, () => {});
    await new Promise<void>(resolve => setImmediate(resolve));
    running = false;
    const elapsed = performance.now() - start;
    if (memory.root.length !== count || memory.tree.size !== nodes || memory.root[0].text !== 'message 0' || memory.root[count - 1].text !== `message ${count - 1}`) throw new Error('memory contents differ');
    await memory.close();
    return { elapsed, longest };
  }
  let worst = 0;
  for (let cycle = 1; cycle <= cycles; cycle++) {
    globalThis.gc?.();
    const before = process.memoryUsage();
    const { elapsed, longest } = await openAndClose();
    // Let the one-second FileStore read cache expire and discard the completed async frame before GC.
    await new Promise(resolve => setTimeout(resolve, 1100));
    globalThis.gc?.();
    const after = process.memoryUsage();
    worst = Math.max(worst, longest);
    console.log(`cycle=${cycle} open_ms=${elapsed.toFixed(1)} max_block_ms=${longest.toFixed(1)} rss_before_mb=${(before.rss / 1048576).toFixed(1)} rss_after_mb=${(after.rss / 1048576).toFixed(1)} heap_before_mb=${(before.heapUsed / 1048576).toFixed(1)} heap_after_mb=${(after.heapUsed / 1048576).toFixed(1)} external_after_mb=${(after.external / 1048576).toFixed(1)} arraybuffers_after_mb=${(after.arrayBuffers / 1048576).toFixed(1)}`);
  }
  if (worst > limit) { console.error(`FAIL max block ${worst.toFixed(1)} ms > ${limit} ms`); process.exitCode = 1; }
} finally { rmSync(dir, { recursive: true, force: true }); }
