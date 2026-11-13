import { PerformanceObserver, performance } from 'node:perf_hooks';

export interface CpuFrame { frame: string; ms: number }
export interface CpuStack { stack: string[]; ms: number }
export interface StallCpu { topSelf: CpuFrame[]; topStacks: CpuStack[]; samples: number }
/** One event-loop stall: when it ended, how long the loop was blocked past its tick, and how much of that a garbage collection explains. */
export interface Stall { at: string; blockedMs: number; gcMs: number; gcKind: string | null; startMs: number; endMs: number; cpu?: StallCpu }
interface Gc { start: number; end: number; kind: number }

const TICK_MS = 100, STALL_MS = 200, KEEP = 20;
const KINDS: Record<number, string> = { 1: 'scavenge', 2: 'mark-sweep-compact', 4: 'incremental', 8: 'weak-callbacks' };

/** A watchdog that wakes every TICK_MS: a late wake-up is a stall. `now` and `wall` are injectable so a test needs no real blocking. */
export function createStallWatch(now: () => number = () => performance.now(), wall: () => number = Date.now) {
  const stalls: Stall[] = [], gcs: Gc[] = [];
  let last = now();
  const noteGc = (start: number, duration: number, kind: number) => {
    gcs.push({ start, end: start + duration, kind });
    if (gcs.length > KEEP) gcs.shift();
  };
  const tick = () => {
    const t = now(), blocked = t - last - TICK_MS;
    if (blocked >= STALL_MS) {
      const overlapping = gcs.filter(gc => gc.end > last && gc.start < t);
      const worst = overlapping.reduce<Gc | undefined>((a, b) => !a || b.end - b.start > a.end - a.start ? b : a, undefined);
      const stall = { at: new Date(wall()).toISOString(), blockedMs: Math.round(blocked),
        gcMs: Math.round(overlapping.reduce((sum, gc) => sum + gc.end - gc.start, 0)), gcKind: worst ? KINDS[worst.kind] ?? String(worst.kind) : null } as Stall;
      // Monotonic bounds stay non-enumerable so existing deepEqual assertions and heap_report JSON keep their exact shape.
      Object.defineProperties(stall, { startMs: { value: last }, endMs: { value: t } });
      stalls.push(stall);
      if (stalls.length > KEEP) stalls.shift();
    }
    last = t;
  };
  return { tick, noteGc, stalls: () => stalls.slice() };
}

/** Stalls survive an extension reload the way the event-loop histogram does: one watchdog per process. */
const SHARED = Symbol.for('pi-optchat.loop-stalls');
export function stallWatch() {
  const slot = globalThis as Record<symbol, ReturnType<typeof createStallWatch> | undefined>;
  if (slot[SHARED]) return slot[SHARED]!;
  const watch = slot[SHARED] = createStallWatch();
  setInterval(watch.tick, TICK_MS).unref();
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) watch.noteGc(e.startTime, e.duration, (e as unknown as { detail?: { kind?: number } }).detail?.kind ?? 0); })
      .observe({ entryTypes: ['gc'] });
  } catch { /* the stall list still works without GC attribution */ }
  return watch;
}
