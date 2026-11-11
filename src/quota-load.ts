import { QUOTA_FILE } from './quota-health.ts';
import { QUOTA_HISTORY_FILE, readQuotaHistory, sampleQuotaFromCache } from './quota-history.ts';
import { analyzeQuota, type Economy } from './quota-economy.ts';
import { aggregateCalls, readUsageAggregate, updateUsageAggregate, type UsageAggregate } from './usage-aggregate.ts';
import { readJsonOr } from './store.ts';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export interface EconomyFiles {
  dir: string; now?: number; weeks?: number; cacheFile?: string;
  /** Replaces the profile's saved usage aggregate (the report script computes its own in memory). */
  aggregate?: UsageAggregate;
}
/**
 * The quota economy from the profile's small files only: the quota history, the quota cache and the usage aggregate that the
 * sampler keeps up to date. It never opens usage.jsonl, so it is cheap enough for a command handler. Read-only.
 */
export function loadEconomy({ dir, now = Date.now(), weeks = 2, cacheFile = QUOTA_FILE, aggregate = readUsageAggregate(dir) }: EconomyFiles): Economy {
  const cached = Object.keys(record(record(readJsonOr<unknown>(cacheFile, {})).usageByProvider));
  // A reading from before the aggregate begins has no calls to weigh, so it would only count points against nothing.
  const history = readQuotaHistory(dir, QUOTA_HISTORY_FILE).filter(row => !aggregate || row.fetchedAt >= aggregate.from);
  const economy = analyzeQuota(history, aggregate ? aggregateCalls(aggregate) : [], now, weeks, cached);
  return aggregate ? economy : { ...economy, usageMissing: true };
}

/**
 * `loadEconomy` at most once per `ttlMs`, as the aggregate only changes every five minutes. A failed read gives `undefined`
 * (the quota lines then simply carry no US$ per 1%), never an error in the command.
 */
export function cachedEconomy(dir: () => string | undefined, ttlMs = 5 * 60_000, weeks = 1, now: () => number = Date.now, files: Partial<EconomyFiles> = {}): () => Economy | undefined {
  let kept: { dir: string; at: number; value: Economy | undefined } | undefined;
  return () => {
    const d = dir(), at = now();
    if (!d) return undefined;
    if (kept?.dir === d && at - kept.at < ttlMs) return kept.value;
    let value: Economy | undefined;
    try { value = loadEconomy({ ...files, dir: d, now: at, weeks }); } catch { value = undefined; }
    kept = { dir: d, at, value };
    return value;
  };
}

/**
 * One round of the quota sampler (the existing 5-minute health timer): the quota history rows from pi-multi-account's cache,
 * then the usage aggregate, which reads only the bytes usage.jsonl gained and gives the event loop a turn between chunks.
 * One failing does not stop the other.
 */
export async function sampleQuotaRound(dir: string, now = Date.now(), cacheFile = QUOTA_FILE): Promise<void> {
  let failure: unknown;
  try { sampleQuotaFromCache(dir, now, cacheFile); } catch (error) { failure = error; }
  try { await updateUsageAggregate({ dir, now }); } catch (error) { failure ??= error; }
  if (failure) throw failure;
}

