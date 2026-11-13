import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import { stallWatch, type Stall, type StallCpu } from './loop-stalls.ts';

const DEFAULT_WINDOW_MS = 10_000;
/** 4000 µs keeps CPU-bound overhead under 2% (~1.95% measured vs 4.44% at 1000 µs) while still capturing ~250 samples/s during stalls. */
const DEFAULT_INTERVAL_US = 4_000;
const TOP_LIMIT = 5;
const MAX_STACK_DEPTH = 8;

export interface CallFrameLike {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber?: number;
}

export interface ProfileNodeLike {
  id: number;
  callFrame: CallFrameLike;
  children?: number[];
}

export interface CpuProfileLike {
  startTime: number;
  endTime: number;
  nodes: ProfileNodeLike[];
  samples?: number[];
  timeDeltas?: number[];
}

export interface StallWatchLike {
  stalls(): Stall[];
}

export interface StallProfilerHandle {
  start(): Promise<void>;
  roll(): Promise<void>;
  stop(): void;
}

const roundMs = (ms: number) => Math.round(ms * 10) / 10;

function formatFrame(frame: CallFrameLike): string {
  const name = frame.functionName || '(anonymous)';
  const url = frame.url || '';
  const file = url ? (url.split(/[\\/]/).pop() || url) : '';
  const line = typeof frame.lineNumber === 'number' && frame.lineNumber >= 0 ? `:${frame.lineNumber + 1}` : '';
  return file ? `${name} (${file}${line})` : name;
}

/** Purely attributes V8 CPU profile samples whose timestamps fall inside [stallStartMs, stallEndMs] (on performance.now() clock). */
export function attributeStallCpu(
  profile: CpuProfileLike,
  windowEndMs: number,
  stallStartMs: number,
  stallEndMs: number,
): StallCpu | undefined {
  const { samples, timeDeltas } = profile;
  if (!samples?.length || !timeDeltas?.length || samples.length !== deltasLength(samples, timeDeltas)) {
    return undefined;
  }

  // V8 profile.startTime / endTime use base::TimeTicks (µs since OS boot), which shares monotonic rate with performance.now()
  // up to a constant offset; anchoring endTime to windowEndMs maps the entire profile onto performance.now().
  const durationMs = Math.max(0, (profile.endTime - profile.startTime) / 1000);
  const windowStartMs = windowEndMs - durationMs;
  if (stallEndMs <= windowStartMs || stallStartMs >= windowEndMs) return undefined;

  const nodeById = new Map<number, ProfileNodeLike>();
  const parentById = new Map<number, number>();
  for (const node of profile.nodes) {
    nodeById.set(node.id, node);
    if (node.children) {
      for (const childId of node.children) parentById.set(childId, node.id);
    }
  }

  const selfTotals = new Map<string, number>();
  const stackTotals = new Map<string, { stack: string[]; ms: number }>();
  let cumMs = 0;
  let count = 0;

  for (let i = 0; i < samples.length; i++) {
    const deltaMs = timeDeltas[i] / 1000;
    cumMs += deltaMs;
    const sampleMs = windowStartMs + cumMs;
    if (sampleMs < stallStartMs || sampleMs > stallEndMs) continue;

    const leaf = nodeById.get(samples[i]);
    if (!leaf || leaf.callFrame.functionName === '(idle)') continue;

    const stack: string[] = [];
    let cur: number | undefined = leaf.id;
    const seen = new Set<number>();
    while (cur !== undefined && stack.length < MAX_STACK_DEPTH && !seen.has(cur)) {
      seen.add(cur);
      const node = nodeById.get(cur);
      if (!node) break;
      const fn = node.callFrame.functionName;
      if (fn !== '(root)' && fn !== '(idle)') stack.push(formatFrame(node.callFrame));
      cur = parentById.get(cur);
    }
    if (stack.length === 0) continue;

    count++;
    const selfFrame = stack[0];
    selfTotals.set(selfFrame, (selfTotals.get(selfFrame) ?? 0) + deltaMs);

    const stackKey = stack.join('\0');
    const existing = stackTotals.get(stackKey);
    if (existing) existing.ms += deltaMs;
    else stackTotals.set(stackKey, { stack, ms: deltaMs });
  }

  if (count === 0) return undefined;

  const topSelf = [...selfTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_LIMIT)
    .map(([frame, ms]) => ({ frame, ms: roundMs(ms) }));

  const topStacks = [...stackTotals.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, TOP_LIMIT)
    .map(({ stack, ms }) => ({ stack, ms: roundMs(ms) }));

  return { topSelf, topStacks, samples: count };
}

function deltasLength(samples: number[], timeDeltas: number[]): number {
  return samples.length === timeDeltas.length ? timeDeltas.length : -1;
}

export function createStallProfiler(opts: { windowMs?: number; intervalUs?: number; watch?: StallWatchLike } = {}): StallProfilerHandle {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const intervalUs = opts.intervalUs ?? DEFAULT_INTERVAL_US;
  const watch = opts.watch ?? stallWatch();

  let session: Session | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let stopped = false;
  let rolling = false;
  let startPromise: Promise<void> | null = null;
  // The previous window is kept too: a stall the watch records only after this roll fired is attributed on the next one.
  let lastProfile: { profile: CpuProfileLike; windowEndMs: number } | null = null;
  let previousProfile: { profile: CpuProfileLike; windowEndMs: number } | null = null;

  const start = async () => {
    if (stopped || started) return startPromise ?? undefined;
    started = true;
    startPromise = (async () => {
      try {
        const s = new Session();
        s.connect();
        session = s;
        await s.post('Profiler.enable');
        await s.post('Profiler.setSamplingInterval', { interval: intervalUs });
        if (stopped) { s.disconnect(); session = null; return; }
        await s.post('Profiler.start');
        if (stopped) { s.disconnect(); session = null; return; }
        timer = setInterval(() => { void roll(); }, windowMs);
        timer.unref();
      } catch {
        // Inspector may be unavailable in restricted runtimes; stallWatch continues without CPU attribution.
        stop();
      }
    })();
    return startPromise;
  };

  const roll = async () => {
    if (stopped || rolling || !session) return;
    rolling = true;
    try {
      const { profile } = await session.post('Profiler.stop');
      const windowEndMs = performance.now();
      if (!stopped && session) await session.post('Profiler.start');
      const typed = profile as unknown as CpuProfileLike;
      previousProfile = lastProfile;
      lastProfile = { profile: typed, windowEndMs };
      for (const stall of watch.stalls()) {
        if (stall.cpu) continue;
        for (const p of [lastProfile, previousProfile]) {
          const cpu = p && attributeStallCpu(p.profile, p.windowEndMs, stall.startMs, stall.endMs);
          if (cpu) { stall.cpu = cpu; break; }
        }
      }
    } catch {
      // Ignore transient stop/start errors when shutting down.
    } finally {
      rolling = false;
    }
  };

  const stop = () => {
    stopped = true;
    lastProfile = previousProfile = null;
    if (timer) { clearInterval(timer); timer = null; }
    if (session) {
      try { session.disconnect(); } catch { /* already disconnected */ }
      session = null;
    }
  };

  return { start, roll, stop };
}

const SHARED = Symbol.for('pi-optchat.stall-profiler');

/** Lazily starts the process-wide rolling CPU stall profiler unless PI_STALL_PROFILER=0. */
export function startStallProfiler(opts?: { windowMs?: number; intervalUs?: number }): StallProfilerHandle | undefined {
  if (process.env.PI_STALL_PROFILER === '0') return undefined;
  const slot = globalThis as Record<symbol, StallProfilerHandle | undefined>;
  if (slot[SHARED]) return slot[SHARED];
  const handle = slot[SHARED] = createStallProfiler(opts);
  void handle.start();
  return handle;
}
