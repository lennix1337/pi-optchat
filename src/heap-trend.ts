

export interface HeapSample { at: number; heapUsedMb: number; afterGc: boolean; rssMb?: number; heapTotalMb?: number; externalMb?: number }
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

/** `Pi RSS 713 MB, above the 500 MB goal in the last 3 samples (V8 heap 366 MB, external 30 MB, other native 317 MB)` while the newest `minPoints` samples carrying an RSS all exceed `limitMb`; undefined otherwise. The heap can sit at 270 MB while native memory keeps the process at 700 MB, so the heap trend alone misses it; the split names which part holds the RSS. */
export function rssLine(samples: readonly HeapSample[], { limitMb = 500, minPoints = 3 } = {}): string | undefined {
  const withRss = samples.filter(sample => sample.rssMb !== undefined), recent = withRss.slice(-minPoints);
  if (recent.length < minPoints || !recent.every(sample => sample.rssMb! > limitMb)) return undefined;
  const last = recent.at(-1)!, line = `Pi RSS ${Math.round(last.rssMb!)} MB, above the ${limitMb} MB goal in the last ${minPoints} samples`;
  if (last.heapTotalMb === undefined || last.externalMb === undefined) return line;
  return `${line} (V8 heap ${Math.round(last.heapTotalMb)} MB, external ${Math.round(last.externalMb)} MB, other native ${Math.round(last.rssMb! - last.heapTotalMb - last.externalMb)} MB)`;
}
