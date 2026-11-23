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
  assert.equal(native.rssMb, 100); assert.equal(native.unaccountedMb, 45);
  assert.equal((report.summary as { unaccountedMb: number }).unaccountedMb, 45);
  assert.equal(native.mappings.length, 8);
  assert.deepEqual(native.children, [{ pid: 123, comm: 'worker', rssMb: 4 }]);
  const floor = await heapReport({}, {}, { platform: 'win32', memoryUsage: () => ({ rss: 1, heapTotal: 2, heapUsed: 1, external: 3, arrayBuffers: 4 }) });
  assert.equal((floor.summary as { unaccountedMb: number }).unaccountedMb, 0);
});

test('native is null outside Linux or when proc is unavailable', async () => {
  const readProc = () => { throw new Error('ENOENT'); };
  for (const platform of ['win32', 'linux'] as const) assert.equal((await heapReport({}, {}, { platform, readProc })).native, null);
});
