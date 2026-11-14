import { PerformanceObserver, performance } from 'node:perf_hooks';

export interface CpuFrame { frame: string; ms: number }
export interface CpuStack { stack: string[]; ms: number }
export interface StallCpu { topSelf: CpuFrame[]; topStacks: CpuStack[]; samples: number }
/** One event-loop stall: when it ended, how long the loop was blocked past its tick, and how much of that a garbage collection explains. */
export interface Stall { at: string; blockedMs: number; gcMs: number; gcKind: string | null; startMs: number; endMs: number; cpu?: StallCpu;
  /** Names (tool:<name>) of the spans in flight or finished inside the stall window; absent when none, i.e. the block ran outside any tool. */
  during?: string[] }
interface Gc { start: number; end: number; kind: number }
interface Span { name: string; start: number; end?: number }

const TICK_MS = 100, STALL_MS = 200, KEEP = 20;
const KINDS: Record<number, string> = { 1: 'scavenge', 2: 'mark-sweep-compact', 4: 'incremental', 8: 'weak-callbacks' };

/** A watchdog that wakes every TICK_MS: a late wake-up is a stall. `now` and `wall` are injectable so a test needs no real blocking. */
export function createStallWatch(now: () => number = () => performance.now(), wall: () => number = Date.now, previous: Stall[] = []) {
  const stalls: Stall[] = previous.slice(-KEEP), gcs: Gc[] = [], spans: Span[] = [];
  let last = now();
  const noteGc = (start: number, duration: number, kind: number) => {
    gcs.push({ start, end: start + duration, kind });
    if (gcs.length > KEEP) gcs.shift();
  };
  /** Marks a named span of work (a tool execution); call the returned function when it ends. Names only, never arguments or output. */
  const begin = (name: string) => {
    const span: Span = { name, start: now() };
    spans.push(span);
    return () => { span.end ??= now(); };
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
      const during = [...new Set(spans.filter(sp => sp.start < t && (sp.end === undefined || sp.end > last)).map(sp => sp.name))];
      if (during.length) stall.during = during;
      stalls.push(stall);
      if (stalls.length > KEEP) stalls.shift();
    }
    last = t;
    while (spans.length > KEEP * 5 || (spans[0]?.end !== undefined && spans[0].end <= last - 60_000)) spans.shift();
  };
  return { tick, noteGc, begin, stalls: () => stalls.slice() };
}

type Watch = ReturnType<typeof createStallWatch>;
interface Held { watch: Watch; build: typeof createStallWatch; stop: () => void }

/** Stalls survive an extension reload the way the event-loop histogram does: one watchdog per process.
 * A reload re-evaluates this module, so a watchdog built by older code (another `build`, or the bare watch
 * stored before `build` existed) is replaced by one with the current API, keeping its stalls. */
const SHARED = Symbol.for('pi-optchat.loop-stalls');
export function stallWatch(): Watch {
  const slot = globalThis as Record<symbol, unknown>;
  const held = slot[SHARED] as Partial<Held> & Partial<Watch> | undefined;
  if (held?.build === createStallWatch) return held.watch!;
  const old = held?.build ? held.watch : held as Watch | undefined;
  held?.stop?.();
  const watch = createStallWatch(undefined, undefined, old?.stalls?.() ?? []);
  const timer = setInterval(watch.tick, TICK_MS); timer.unref();
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver(list => { for (const e of list.getEntries()) watch.noteGc(e.startTime, e.duration, (e as unknown as { detail?: { kind?: number } }).detail?.kind ?? 0); });
    observer.observe({ entryTypes: ['gc'] });
  } catch { /* the stall list still works without GC attribution */ }
  slot[SHARED] = { watch, build: createStallWatch, stop: () => { clearInterval(timer); observer?.disconnect(); } } satisfies Held;
  return watch;
}
