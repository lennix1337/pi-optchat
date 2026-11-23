import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heapReport, parseSmapsRollup, parseSmaps, parseChildren, parseChildStatus } from '../src/heap-report.ts';

const rollup = 'Rss: 102400 kB\nPss_Anon: 51200 kB\nPss_File: 20480 kB\nPss_Shmem: 10240 kB\nSwap: 2048 kB\n';
const mapping = (i: number, name: string, rss: number) => `${i.toString(16)}-${(i + 1).toString(16)} rw-p 00000000 00:00 0 ${name}\nSize: 20480 kB\nRss: ${rss} kB\n`;
const smaps = Array.from({ length: 9 }, (_, i) => mapping(i + 1, i === 8 ? '/secret/path/library.so' : i === 7 ? '[heap]' : '', (i + 1) * 1024)).join('');

test('native parsers summarize rollup and rank mappings without paths or addresses', () => {
  assert.deepEqual(parseSmapsRollup(rollup), { rssMb: 100, pssAnonMb: 50, pssFileMb: 20, pssShmemMb: 10, swapMb: 2 });
  const maps = parseSmaps(smaps);
  assert.equal(maps.length, 8);
  assert.deepEqual(maps[0], { sizeMb: 20, rssMb: 9, perm: 'rw-p', kind: 'library.so' });
  assert.equal(maps[1].kind, '[heap]');
  assert.equal(maps[2].kind, 'heap-anon');
  assert.doesNotMatch(JSON.stringify(maps), /secret|path|00000000/);
  assert.equal(parseSmaps(mapping(1, '[stack]', 1024))[0].kind, '[stack]');
  assert.equal(parseSmaps(mapping(1, '[vdso]', 1024))[0].kind, '[anon]');
});

test('children parsers use pid list and only first comm word and RSS', () => {
  assert.deepEqual(parseChildren('123 456\n'), [123, 456]);
  assert.deepEqual(parseChildStatus('Name:\tworker secret\nVmRSS:\t4096 kB\n'), { comm: 'worker', rssMb: 4 });
});

test('heap report injects Linux native readers and accounts for native memory', async () => {
  const files: Record<string, string> = { '/proc/self/smaps_rollup': rollup, '/proc/self/smaps': smaps,
    [`/proc/self/task/${process.pid}/children`]: '123 456', '/proc/123/status': 'Name:\tworker secret\nVmRSS:\t4096 kB\n' };
  const report = await heapReport({}, {}, { platform: 'linux', readProc: path => { if (!(path in files)) throw new Error('ENOENT'); return files[path]; },
    memoryUsage: () => ({ rss: 100 * 1048576, heapTotal: 40 * 1048576, heapUsed: 30 * 1048576, external: 10 * 1048576, arrayBuffers: 5 * 1048576 }) });
  const native = report.native as { unaccountedMb: number; children: unknown[]; mappings: unknown[]; rssMb: number };
  assert.equal(native.rssMb, 100); assert.equal(native.unaccountedMb, 42);
  assert.equal((report.summary as { unaccountedMb: number }).unaccountedMb, 42);
  assert.equal(native.mappings.length, 8);
  assert.deepEqual(native.children, [{ pid: 123, comm: 'worker', rssMb: 4 }]);
  const floor = await heapReport({}, {}, { platform: 'linux', readProc: path => files[path], memoryUsage: () => ({ rss: 1, heapTotal: 2, heapUsed: 1, external: 3, arrayBuffers: 4 }) });
  assert.equal((floor.summary as { unaccountedMb: number }).unaccountedMb, 0);
});

test('native breakdown totals all heap and binary mappings without double-counting array buffers', async () => {
  const big = Array.from({ length: 8 }, (_, i) => mapping(i + 1, '', 80 * 1024)).join('');
  const maps = big + mapping(9, '[heap]', 72 * 1024) + mapping(10, '/fake/bin/node', 40 * 1024)
    + mapping(11, '/fake/bin/node', 18 * 1024);
  const files: Record<string, string> = { '/proc/self/smaps_rollup': rollup, '/proc/self/smaps': maps,
    [`/proc/self/task/${process.pid}/children`]: '' };
  const report = await heapReport({}, {}, { platform: 'linux', executableName: 'node', readProc: path => files[path],
    memoryUsage: () => ({ rss: 580 * 1048576, heapTotal: 300 * 1048576, heapUsed: 276 * 1048576, external: 100 * 1048576, arrayBuffers: 80 * 1048576 }) });
  const native = report.native as { breakdown: unknown; mappings: { kind: string }[]; unaccountedMb: number };
  assert.equal(native.mappings.length, 8);
  assert.ok(native.mappings.every(item => item.kind === 'heap-anon'));
  assert.deepEqual(native.breakdown, { v8HeapMb: 300, mallocHeapMb: 72, binaryMb: 58, externalMb: 100, residualMb: 50 });
  assert.equal(native.unaccountedMb, 50);
  assert.equal((report.summary as { unaccountedMb: number }).unaccountedMb, 50);
});

test('native is null outside Linux or when proc is unavailable', async () => {
  const readProc = () => { throw new Error('ENOENT'); };
  for (const platform of ['win32', 'linux'] as const) {
    const report = await heapReport({}, {}, { platform, readProc });
    assert.equal(report.native, null);
    assert.equal((report.summary as { unaccountedMb: number | null }).unaccountedMb, null);
  }
});
