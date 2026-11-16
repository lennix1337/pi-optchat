import { constants, PerformanceObserver, performance } from 'node:perf_hooks';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface CpuFrame { frame: string; ms: number }
export interface CpuStack { stack: string[]; ms: number }
export interface StallCpu { topSelf: CpuFrame[]; topStacks: CpuStack[]; samples: number }
/** One event-loop stall: when it ended, how long the loop was blocked past its tick, and how much of that a garbage collection explains. */
export interface Stall { at: string; blockedMs: number; gcMs: number; gcKind: string | null; startMs: number; endMs: number; cpu?: StallCpu;
  /** Names of instrumented spans overlapping the window. Missing names do not rule out work in uninstrumented code. */
  during?: string[];
  /** Wall-time overlap with the stall window (spans under 10 ms omitted); async spans can include waiting, not CPU use. */
  spanMs?: Record<string, number> }
interface Gc { start: number; end: number; kind: number }
interface Span { name: string; start: number; end?: number }

const TICK_MS = 100, STALL_MS = 200, KEEP = 20;
const KINDS: Record<number, string> = { [constants.NODE_PERFORMANCE_GC_MINOR]: 'scavenge', 2: 'minor-mark-sweep',
  [constants.NODE_PERFORMANCE_GC_MAJOR]: 'mark-sweep-compact', [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weak-callbacks' };
type GcTotals = WeakMap<Stall, { total: number; worst?: Gc }>;

function attributeLateGc(stalls: Stall[], gc: Gc, totalsByStall: GcTotals) {
  for (const stall of stalls) {
    const totals = totalsByStall.get(stall);
    if (!totals || gc.end <= stall.startMs || gc.start >= stall.endMs) continue;
    const duration = gc.end - gc.start;
    totals.total += duration;
    stall.gcMs = Math.round(totals.total);
    if (!totals.worst || duration > totals.worst.end - totals.worst.start) {
      totals.worst = gc;
      stall.gcKind = KINDS[gc.kind] ?? String(gc.kind);
    }
  }
}

/** A watchdog that wakes every TICK_MS: a late wake-up is a stall. `now` and `wall` are injectable so a test needs no real blocking. */
export function createStallWatch(now: () => number = () => performance.now(), wall: () => number = Date.now, previous: Stall[] = []) {
  const stalls: Stall[] = previous.slice(-KEEP), gcs: Gc[] = [], spans: Span[] = [];
  const gcTotals: GcTotals = new WeakMap();
  let last = now();
  const noteGc = (start: number, duration: number, kind: number) => {
    const gc = { start, end: start + duration, kind };
    gcs.push(gc);
    if (gcs.length > KEEP) gcs.shift();
    // PerformanceObserver delivers GC entries asynchronously, sometimes after the watchdog tick.
    attributeLateGc(stalls, gc, gcTotals);
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
      const total = overlapping.reduce((sum, gc) => sum + gc.end - gc.start, 0);
      const stall = { at: new Date(wall()).toISOString(), blockedMs: Math.round(blocked),
        gcMs: Math.round(total), gcKind: worst ? KINDS[worst.kind] ?? String(worst.kind) : null } as Stall;
      // Monotonic bounds stay non-enumerable so existing deepEqual assertions and heap_report JSON keep their exact shape.
      Object.defineProperties(stall, { startMs: { value: last }, endMs: { value: t } });
      gcTotals.set(stall, { total, worst });
      const inside = spans.filter(sp => sp.start < t && (sp.end === undefined || sp.end > last));
      const during = [...new Set(inside.map(sp => sp.name))];
      if (during.length) stall.during = during;
      const spanMs: Record<string, number> = {};
      for (const sp of inside) {
        const ms = Math.round(Math.min(sp.end ?? t, t) - Math.max(sp.start, last));
        if (ms >= 10) spanMs[sp.name] = (spanMs[sp.name] ?? 0) + ms;
      }
      if (Object.keys(spanMs).length) stall.spanMs = spanMs;
      stalls.push(stall);
      if (stalls.length > KEEP) stalls.shift();
    }
    last = t;
    // Keep active spans even if many short hooks finish during them. Only completed history is evicted.
    let excess = Math.max(0, spans.length - KEEP * 5), kept = 0;
    for (const span of spans) {
      if (span.end !== undefined && (excess > 0 || span.end <= last - 60_000)) { if (excess > 0) excess--; continue; }
      spans[kept++] = span;
    }
    spans.length = kept;
  };
  return { tick, noteGc, begin, stalls: () => stalls.slice() };
}

type Watch = ReturnType<typeof createStallWatch>;

/** Runs `step` as a named stall span that ends when it returns, throws or (for a promise) settles; returns its result unchanged. */
export function spanned<T>(name: string, step: () => T, watch: Pick<Watch, 'begin'> = stallWatch()): T {
  const end = watch.begin(name);
  let result: T;
  try { result = step(); } catch (error) { end(); throw error; }
  if (result instanceof Promise) return result.finally(end) as T;
  end();
  return result;
}

/** Names OptChat's hook handlers as stall spans (`hook:<event>`); tool completion handlers also name their source file and line.
 * Other extensions and Pi itself are not wrapped here. Returns a view of `pi` without mutating the host, which may be a Proxy. */
export function spanHooks<T extends { on: (event: any, handler: (...args: any[]) => any) => unknown }>(pi: T, watch: Pick<Watch, 'begin'> = stallWatch()): T {
  const on: T['on'] = (event, handler) => {
    // Registration happens once; retain only the source basename and line, never an absolute user path.
    const location = event === 'tool_result' || event === 'tool_execution_end'
      ? new Error().stack?.split('\n').map(line => /(?:^|[\\/ (])([^\\/(): ]+\.[cm]?[jt]s):(\d+):\d+\)?$/.exec(line))
        .find(match => match && match[1] !== 'loop-stalls.ts')
      : undefined;
    const detail = location ? `handler:${event}:${location[1]}:${location[2]}` : undefined;
    return pi.on(event, (...args: unknown[]) => spanned(`hook:${event}`,
      () => detail ? spanned(detail, () => handler(...args), watch) : handler(...args), watch));
  };
  return new Proxy(pi, { get: (target, property, receiver) => property === 'on' ? on : Reflect.get(target, property, receiver) });
}
/** Broad lifecycle overlaps only: they locate a stall in an interval, not the code that consumed CPU. No inputs or ids are recorded. */
export function registerStallPhases(pi: ExtensionAPI, watch: Pick<Watch, 'begin'> = stallWatch()) {
  type End = () => void;
  let agent: End | undefined, turn: End | undefined, provider: End | undefined, stream: End | undefined, compact: End | undefined;
  const bash = new Map<string, { before?: End; after?: End }>();
  const close = (end: End | undefined) => { end?.(); };
  const clear = () => {
    close(agent); close(turn); close(provider); close(stream); close(compact);
    agent = turn = provider = stream = compact = undefined;
    for (const phase of bash.values()) { close(phase.before); close(phase.after); }
    bash.clear();
  };
  pi.on('agent_start', () => { close(agent); agent = watch.begin('phase:agent'); });
  pi.on('turn_start', () => { close(turn); turn = watch.begin('phase:turn'); });
  pi.on('turn_end', () => { close(turn); turn = undefined; });
  pi.on('before_provider_request', () => { close(provider); provider = watch.begin('phase:provider'); });
  pi.on('message_start', event => { if (event.message.role === 'assistant') { close(stream); stream = watch.begin('phase:assistant-stream'); } });
  pi.on('message_end', event => { if (event.message.role === 'assistant') { close(stream); close(provider); stream = provider = undefined; } });
  pi.on('session_before_compact', () => { close(compact); compact = watch.begin('phase:compact'); });
  pi.on('session_compact', () => { close(compact); compact = undefined; });
  pi.on('session_compact_failed', () => { close(compact); compact = undefined; });
  // Pi fires tool_call before execution and tool_result after it, but other extensions may run before or after our handlers.
  pi.on('tool_execution_start', event => { if (event.toolName === 'bash') { const old = bash.get(event.toolCallId); close(old?.before); close(old?.after); bash.set(event.toolCallId, {}); } });
  pi.on('tool_call', event => { const phase = bash.get(event.toolCallId); if (phase && event.toolName === 'bash') { close(phase.before); phase.before = watch.begin('phase:bash-call-to-result'); } });
  pi.on('tool_result', event => { const phase = bash.get(event.toolCallId); if (phase && event.toolName === 'bash') { close(phase.before); close(phase.after); phase.before = undefined; phase.after = watch.begin('phase:bash-result-to-end'); } });
  pi.on('tool_execution_end', event => { const phase = bash.get(event.toolCallId); if (phase) { close(phase.before); close(phase.after); bash.delete(event.toolCallId); } });
  pi.on('agent_settled', clear);
  pi.on('session_shutdown', clear);
}

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
