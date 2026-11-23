import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import vm from 'node:vm';
import { Type } from 'typebox';
import { stallWatch } from './loop-stalls.ts';
import { startStallProfiler } from './stall-profiler.ts';
import type { Memory } from './memory.ts';

// external: V8 heap snapshots need roughly as much memory as the heap.
const SNAPSHOT_HEAP_SHARE = 0.25;
const SNAPSHOT_RSS_FACTOR_MEASURED_ON_LIVE_PI = 2.3, SNAPSHOT_RSS_CEILING = 1000 * 1024 * 1024;
const SUMMARY_TIMEOUT_MS = 180_000, SUMMARY_TOP = 30;
const MB = 1024 * 1024;
const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;
const mb = (bytes: number) => round(bytes / MB);

// external: Pi can reuse extension module state across reloads.
interface Shared { loop?: ReturnType<typeof monitorEventLoopDelay>; reloads: number }
const SHARED = Symbol.for('pi-optchat.heap-report');
const shared = (): Shared => ((globalThis as Record<symbol, Shared>)[SHARED] ??= { reloads: 0 });
function loop() {
  const state = shared();
  if (!state.loop) { state.loop = monitorEventLoopDelay({ resolution: 10 }); state.loop.enable(); }
  return state.loop;
}
stallWatch();
startStallProfiler();
loop();
/** Called when a reload tears a profile down. */
export const noteReload = () => { shared().reloads++; };
export const reloadCount = () => shared().reloads;

export type MemoryStats = ReturnType<Memory['stats']>;
/** Sizes of the collections that live as long as the process (name -> count or characters), so one that only grows names itself. */
export type Collections = Record<string, number>;
export interface OptChatSide { memory: MemoryStats; run: number; reloads: number; collections: Collections }
/** The parts of Pi's session manager the report reads, all optional so an older Pi still reports what it has. */
export interface SessionLike {
  getEntryCount?(): number;
  getEntries?(): readonly unknown[];
  buildContextEntries?(): readonly unknown[];
  getBranch?(): readonly { type?: string }[];
  getSessionFile?(): string | undefined;
}
export interface HeapSources { session?: SessionLike; optchat?: OptChatSide }
export interface SnapshotSummary { nodes?: number; selfBytes?: number; byType?: Record<string, { count: number; selfBytes: number }>;
  topConstructors: { name: string; type?: string; count: number; selfBytes: number }[];
  /** Non-weak incoming references, not unique or retained bytes. */
  stringRetainers?: { ownerType: string; edge: string; references: number; referencedSelfBytes: number }[] }
/** Everything that touches the machine, so tests can inject a heap that is too big or a snapshot that is never written. */
export interface HeapDeps {
  heapStats(): v8.HeapInfo;
  platform: NodeJS.Platform;
  executableName: string;
  readProc(path: string): string;
  memoryUsage(): NodeJS.MemoryUsage;
  freeMemory(): number;
  rssBytes(): number;
  collect(): void;
  writeSnapshot(file: string): string;
  summarize(file: string): Promise<SnapshotSummary>;
}

function collect() {
  // external: Node exposes gc to contexts created after the flag is set.
  v8.setFlagsFromString('--expose-gc');
  (vm.runInNewContext('gc') as () => void)();
}

function summarize(file: string): Promise<SnapshotSummary> {
  return new Promise((resolve, reject) => {
    const exe = /^node(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : 'node';
    const child = spawn(exe, [new URL('./heap-snapshot-summary.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), file, String(SUMMARY_TOP)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: SUMMARY_TIMEOUT_MS });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { if (err.length < 2000) err += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(`summary exited ${code}${err ? `: ${err.trim().slice(0, 300)}` : ''}`));
      try { resolve(JSON.parse(out) as SnapshotSummary); } catch (error) { reject(error); }
    });
  });
}
const realDeps: HeapDeps = { heapStats: () => v8.getHeapStatistics(), platform: process.platform, executableName: basename(process.execPath), readProc: path => readFileSync(path, 'utf8'),
  memoryUsage: () => process.memoryUsage(), freeMemory: freemem, rssBytes: () => process.memoryUsage.rss(), collect, summarize,
  writeSnapshot: file => v8.writeHeapSnapshot(file) };


export function parseSmapsRollup(text: string) {
  const fields = new Map(Array.from(text.matchAll(/^(Rss|Pss_Anon|Pss_File|Pss_Shmem|Swap):\s+(\d+)\s+kB$/gm), m => [m[1], Number(m[2])]));
  const value = (key: string) => fields.has(key) ? mb(fields.get(key)! * 1024) : null;
  return { rssMb: value('Rss'), pssAnonMb: value('Pss_Anon'), pssFileMb: value('Pss_File'), pssShmemMb: value('Pss_Shmem'), swapMb: value('Swap') };
}

function allSmaps(text: string) {
  const mappings: { sizeKb: number; rssKb: number; perm: string; kind: string }[] = [];
  let current: { sizeKb: number; rssKb: number; perm: string; kind: string } | undefined;
  for (const line of text.split('\n')) {
    const header = line.match(/^[\da-f]+-[\da-f]+\s+(\S+)\s+\S+\s+\S+\s+\d+\s*(.*)$/i);
    if (header) {
      const name = header[2].trim();
      const kind = !name ? 'heap-anon' : name === '[heap]' || name === '[stack]' ? name : name.startsWith('[') ? '[anon]' : basename(name);
      current = { sizeKb: 0, rssKb: 0, perm: header[1], kind }; mappings.push(current);
    } else if (current) {
      const field = line.match(/^(Size|Rss):\s+(\d+)\s+kB$/);
      if (field) current[field[1] === 'Size' ? 'sizeKb' : 'rssKb'] = Number(field[2]);
    }
  }
  return mappings;
}

function topSmaps(mappings: ReturnType<typeof allSmaps>) {
  return [...mappings].sort((a, b) => b.rssKb - a.rssKb).slice(0, 8)
    .map(({ sizeKb, rssKb, perm, kind }) => ({ sizeMb: mb(sizeKb * 1024), rssMb: mb(rssKb * 1024), perm, kind }));
}

export function parseSmaps(text: string) { return topSmaps(allSmaps(text)); }

export function parseChildren(text: string) {
  return text.trim().split(/\s+/).filter(word => /^\d+$/.test(word) && Number(word) > 0).map(Number);
}

export function parseChildStatus(text: string) {
  const comm = text.match(/^Name:\s*(\S+)/m)?.[1], rss = text.match(/^VmRSS:\s*(\d+)\s+kB$/m)?.[1];
  return comm && rss !== undefined ? { comm, rssMb: mb(Number(rss) * 1024) } : null;
}

function nativeMemory(deps: HeapDeps, usage: NodeJS.MemoryUsage) {
  if (deps.platform !== 'linux') return null;
  try {
    const rollup = parseSmapsRollup(deps.readProc('/proc/self/smaps_rollup'));
    const all = allSmaps(deps.readProc('/proc/self/smaps'));
    const total = (kind: string) => all.reduce((sum, item) => sum + (item.kind === kind ? item.rssKb * 1024 : 0), 0);
    const malloc = total('[heap]'), binary = total(deps.executableName);
    const residual = Math.max(0, usage.rss - usage.heapTotal - malloc - binary - usage.external);
    const breakdown = { v8HeapMb: mb(usage.heapTotal), mallocHeapMb: mb(malloc), binaryMb: mb(binary),
      externalMb: mb(usage.external), residualMb: mb(residual) };
    const mappings = topSmaps(all);
    const children = parseChildren(deps.readProc(`/proc/self/task/${process.pid}/children`)).flatMap(pid => {
      try { const child = parseChildStatus(deps.readProc(`/proc/${pid}/status`)); return child ? [{ pid, ...child }] : []; }
      catch { return []; }
    });
    return { ...rollup, unaccountedMb: breakdown.residualMb, breakdown, mappings, children };
  } catch { return null; }
}

function piSide(session: SessionLike) {
  const attempt = <T>(read: () => T | undefined): T | null => { try { return read() ?? null; } catch { return null; } };
  const branch = attempt(() => session.getBranch?.());
  const compacted = branch ? branch.findLastIndex(entry => entry.type === 'compaction') : -1;
  return {
    entries: attempt(() => session.getEntryCount?.() ?? session.getEntries?.().length),
    contextEntries: attempt(() => session.buildContextEntries?.().length),
    branchEntries: branch?.length ?? null,
    sinceCompaction: branch ? branch.length - compacted - 1 : null,
    sessionFileBytes: attempt(() => { const file = session.getSessionFile?.(); return file ? statSync(file).size : undefined; }),
  };
}
function activeResources() {
  const counts: Record<string, number> = {};
  const list = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
  for (const name of list) counts[name] = (counts[name] ?? 0) + 1;
  return { total: list.length, byType: counts };
}
function eventLoop() {
  const histogram = loop(), count = histogram.count;
  const ms = (ns: number) => count ? round(ns / 1e6) : 0;
  const result = { samples: count, p50Ms: ms(histogram.percentile(50)), p99Ms: ms(histogram.percentile(99)), maxMs: ms(histogram.max) };
  histogram.reset();
  return result;
}
const spaces = () => v8.getHeapSpaceStatistics().map(space => ({ name: space.space_name, sizeMb: mb(space.space_size), usedMb: mb(space.space_used_size), availableMb: mb(space.space_available_size) }));

export async function heapReport(input: { gc?: boolean; snapshot?: boolean; allowRssInflation?: boolean }, sources: HeapSources, overrides: Partial<HeapDeps> = {}) {
  const deps = { ...realDeps, ...overrides };
  const result: Record<string, unknown> = { at: new Date().toISOString(), pid: process.pid, node: process.version, uptimeS: round(process.uptime(), 0) };
  let gc: Record<string, number> | undefined;
  if (input.gc) {
    const heapUsedBefore = process.memoryUsage().heapUsed, started = performance.now();
    deps.collect();
    gc = { pauseMs: round(performance.now() - started, 2), heapUsedBefore, heapUsedAfter: process.memoryUsage().heapUsed };
  }
  const heap = deps.heapStats(), usage = deps.memoryUsage();
  const native = nativeMemory(deps, usage), unaccountedMb = native?.breakdown.residualMb ?? null;
  result.summary = { rssMb: mb(usage.rss), unaccountedMb, heapUsedMb: mb(heap.used_heap_size), heapLimitMb: mb(heap.heap_size_limit),
    heapUsedPercentOfLimit: round(heap.used_heap_size / heap.heap_size_limit * 100), afterGc: Boolean(gc) };
  if (input.snapshot) result.snapshot = await snapshot(heap, deps, Boolean(input.allowRssInflation));
  result.native = native;
  result.memoryUsage = usage;
  result.v8 = { heap, spaces: spaces() };
  result.eventLoop = { ...eventLoop(), stalls: stallWatch().stalls() };
  result.process = { exitListeners: process.listenerCount('exit'), activeResources: activeResources() };
  result.pi = sources.session ? piSide(sources.session) : null;
  result.optchat = sources.optchat ?? null;
  if (gc) result.gc = gc;
  return result;
}
async function snapshot(heap: v8.HeapInfo, deps: HeapDeps, allowInflation: boolean) {
  const free = deps.freeMemory(), used = heap.used_heap_size, limit = heap.heap_size_limit;
  const refusal = used > limit * SNAPSHOT_HEAP_SHARE ? `the heap is ${mb(used)} MB, over 25% of its ${mb(limit)} MB limit: a snapshot needs about as much memory again`
    : !allowInflation && deps.rssBytes() + SNAPSHOT_RSS_FACTOR_MEASURED_ON_LIVE_PI * used > SNAPSHOT_RSS_CEILING ? `RSS is ${mb(deps.rssBytes())} MB and a snapshot of this ${mb(used)} MB heap would push it to about ${mb(deps.rssBytes() + SNAPSHOT_RSS_FACTOR_MEASURED_ON_LIVE_PI * used)} MB, kept until restart; pass allowRssInflation:true to accept that`
    : free < 2 * used ? `free memory is ${mb(free)} MB, under twice the heap (${mb(used)} MB)` : undefined;
  if (refusal) return { refused: true, reason: refusal, heapUsedBytes: used, heapLimitBytes: limit, freeMemoryBytes: free };
  const started = performance.now(), file = join(tmpdir(), `pi-optchat-heap-${process.pid}-${Date.now()}.heapsnapshot`);
  const rssBefore = deps.rssBytes(), written = deps.writeSnapshot(file), rssAfter = deps.rssBytes(), wroteMs = round(performance.now() - started);
  const out: Record<string, unknown> = { file: written, bytes: (() => { try { return statSync(written).size; } catch { return null; } })(), writeMs: wroteMs,
    rssBeforeMb: mb(rssBefore), rssAfterMb: mb(rssAfter) };
  if (rssAfter - rssBefore > 100 * MB) out.warning = 'O snapshot em processo pode inflar o RSS; a memória pode não ser devolvida até reiniciar.';
  try { Object.assign(out, await deps.summarize(written), { summaryMs: round(performance.now() - started - wroteMs) }); }
  catch (error) { out.summaryError = error instanceof Error ? error.message : String(error); }
  return out;
}

export const heapReportTool = (optchat: () => OptChatSide | undefined) => ({
  name: 'heap_report', label: 'Heap report', exposure: 'deferred' as const, annotations: { readOnlyHint: true },
  description: 'Memory and event-loop numbers of this Pi process, its session and OptChat memory: process.memoryUsage, V8 heap and space statistics, event-loop delay p50/p99/max since the last report plus the last stalls over 200 ms (time, blocked ms, and the garbage collection that overlapped it), exit listeners and active resources, session entry counts and file size, OptChat memory rows, live texts and caches. Linux native RSS breakdown, largest mappings (basenames only), and direct children (first comm word and RSS). The breakdown is approximate: heap and external sizes can overlap resident mappings. Counts and sizes only, no contents or paths. '
    + 'gc:true forces a collection first (reports the pause and heap after it). snapshot:true writes a .heapsnapshot in this process, which can inflate RSS and may not return memory until restart; it summarizes the file in a child process and is refused when the heap is over 25% of V8\'s limit or free memory is under twice the heap. Never attach the V8 inspector to a live Pi: use this.',
  parameters: Type.Object({
    gc: Type.Optional(Type.Boolean({ description: 'Force a garbage collection first and report the heap after it, with the pause.' })),
    allowRssInflation: Type.Optional(Type.Boolean({ description: 'Take the snapshot even when it would push RSS past 1 GB (it is refused by default: the memory stays until restart).' })),
    snapshot: Type.Optional(Type.Boolean({ description: 'Write a heap snapshot to the temp folder and summarize its top constructors; refused when the heap is large or memory is short.' })),
  }, { additionalProperties: false }),
  async execute(_id: string, args: { gc?: boolean; snapshot?: boolean; allowRssInflation?: boolean }, _signal: AbortSignal | undefined, _update: unknown, ctx: { sessionManager?: SessionLike }) {
    const report = await heapReport(args, { session: ctx.sessionManager, optchat: optchat() });
    return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }], details: {} };
  },
});
