/**
 * Classifies prompt-cache writes of `role: main` turns from usage.jsonl records, so cost work
 * (cold-turn refresh, head-change misses, cheap wakes) can be compared before and after with the same numbers.
 */
export interface UsageRecord {
  date: string;
  role?: string;
  model?: string;
  session?: string;
  usage?: { cacheRead: number; cacheWrite: number; cost: { cacheWrite: number; total: number } };
}

export type MissClass = 'small' | 'first' | 'cold' | 'headChange' | 'growth';
export interface MissBucket { turns: number; cacheWriteUsd: number; cacheWriteTokens: number }
export interface MissReport { byClass: Record<MissClass, MissBucket>; byDay: Record<string, MissBucket>; totalUsd: number }

/** Writes below this are normal per-turn growth (new tool output), not a miss. */
export const SMALL_WRITE_TOKENS = 8000;
/** Idle minutes after which the previous turn's cache is considered gone (5-min cache). */
export const COLD_GAP_MINUTES = 5;

const emptyBucket = (): MissBucket => ({ turns: 0, cacheWriteUsd: 0, cacheWriteTokens: 0 });
const add = (b: MissBucket, tokens: number, usd: number) => { b.turns++; b.cacheWriteTokens += tokens; b.cacheWriteUsd += usd; };

/**
 * headChange: a large write while the cache was still warm and the read fell below half of the previous read —
 * the cached prefix changed (view rewrite, tool-set change, model/account switch).
 * growth: a large write with a warm, kept prefix (the conversation simply grew).
 */
export function classifyCacheMisses(records: readonly UsageRecord[], filter: { model?: string; since?: string } = {}): MissReport {
  const byClass: Record<MissClass, MissBucket> = { small: emptyBucket(), first: emptyBucket(), cold: emptyBucket(), headChange: emptyBucket(), growth: emptyBucket() };
  const byDay: Record<string, MissBucket> = {};
  const last = new Map<string, { t: number; read: number }>();
  let totalUsd = 0;
  for (const r of records) {
    if (r.role !== 'main' || !r.usage || (filter.model && r.model !== filter.model) || (filter.since && r.date < filter.since)) continue;
    const key = r.session ?? '';
    const t = Date.parse(r.date);
    const prev = last.get(key);
    last.set(key, { t, read: r.usage.cacheRead });
    const { cacheWrite, cacheRead, cost } = r.usage;
    totalUsd += cost.total;
    let cls: MissClass;
    if (cacheWrite < SMALL_WRITE_TOKENS) cls = 'small';
    else if (!prev) cls = 'first';
    else if ((t - prev.t) / 60000 > COLD_GAP_MINUTES) cls = 'cold';
    else cls = cacheRead < prev.read * 0.5 && cacheRead < cacheWrite ? 'headChange' : 'growth';
    add(byClass[cls], cacheWrite, cost.cacheWrite);
    if (cls === 'headChange') add(byDay[r.date.slice(0, 10)] ??= emptyBucket(), cacheWrite, cost.cacheWrite);
  }
  return { byClass, byDay, totalUsd };
}
