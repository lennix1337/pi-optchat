// Heap growth watch: the heartbeat samples the Pi heap each tick, and a steady rise over hours is a leak worth a radar line.

export interface HeapSample { at: number; heapUsedMb: number; afterGc: boolean }
export interface HeapGrowth { mbPerHour: number; spanH: number; fromMb: number; toMb: number }

const HOUR = 3_600_000;

/** The samples with this one added, the older than `keepMs` (24 h) dropped. */
export function recordHeapSample(samples: readonly HeapSample[], sample: HeapSample, keepMs = 24 * HOUR): HeapSample[] {
  return [...samples, sample].filter(kept => kept.at > sample.at - keepMs);
}

/** The least-squares slope of the samples up to `now`: undefined while they span less than `minSpanMs` (2 h) or number fewer than `minPoints` (4).
 * Samples taken right after a collection are the honest ones, so they alone are used once there are enough of them; `fromMb`/`toMb` are the fitted ends. */
export function heapGrowth(samples: readonly HeapSample[], now: number, { minSpanMs = 2 * HOUR, minPoints = 4 } = {}): HeapGrowth | undefined {
  const past = samples.filter(sample => sample.at <= now), collected = past.filter(sample => sample.afterGc);
  const used = collected.length >= minPoints ? collected : past;
  if (used.length < minPoints) return undefined;
  const first = Math.min(...used.map(sample => sample.at)), last = Math.max(...used.map(sample => sample.at));
  if (last - first < minSpanMs) return undefined;
  const points = used.map(sample => ({ x: (sample.at - first) / HOUR, y: sample.heapUsedMb }));
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / points.length, meanY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  const spread = points.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
  const slope = points.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0) / spread;
  const spanH = (last - first) / HOUR, at = (x: number) => meanY + slope * (x - meanX);
  return { mbPerHour: slope, spanH, fromMb: at(0), toMb: at(spanH) };
}

/** `Pi heap grows ~110 MB/h over 12 h (1470 -> 2671 MB)` once the slope reaches `thresholdMbPerHour` (50); undefined otherwise. */
export function heapGrowthLine(growth: HeapGrowth | undefined, { thresholdMbPerHour = 50 } = {}): string | undefined {
  if (!growth || !(growth.mbPerHour >= thresholdMbPerHour)) return undefined;
  return `Pi heap grows ~${Math.round(growth.mbPerHour)} MB/h over ${Math.round(growth.spanH)} h (${Math.round(growth.fromMb)} -> ${Math.round(growth.toMb)} MB)`;
}
