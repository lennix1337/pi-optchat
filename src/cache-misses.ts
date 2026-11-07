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
/** modelSwitch: the head changes whose previous main turn ran on another model, a subset of byClass.headChange (the provider caches per model). */
export interface MissReport { byClass: Record<MissClass, MissBucket>; byDay: Record<string, MissBucket>; modelSwitch: MissBucket; totalUsd: number }

/** Writes below this are normal per-turn growth (new tool output), not a miss. */
export const SMALL_WRITE_TOKENS = 8000;
/** Idle minutes after which the previous turn's cache may be gone; it counts as gone only when the read really fell (a 1-hour entry survives the wait). */
export const COLD_GAP_MINUTES = 5;

const emptyBucket = (): MissBucket => ({ turns: 0, cacheWriteUsd: 0, cacheWriteTokens: 0 });
const add = (b: MissBucket, tokens: number, usd: number) => { b.turns++; b.cacheWriteTokens += tokens; b.cacheWriteUsd += usd; };

/**
 * cold: a large write after an idle gap whose read fell below half of the previous read; a kept prefix after the gap is growth.
 * headChange: a large write while the cache was still warm and the read fell below half of the previous read —
 * the cached prefix changed (view rewrite, tool-set change, model/account switch).
 * growth: a large write with a warm, kept prefix (the conversation simply grew).
 */
export function classifyCacheMisses(records: readonly UsageRecord[], filter: { model?: string; since?: string } = {}): MissReport {
  const byClass: Record<MissClass, MissBucket> = { small: emptyBucket(), first: emptyBucket(), cold: emptyBucket(), headChange: emptyBucket(), growth: emptyBucket() };
  const byDay: Record<string, MissBucket> = {};
  const modelSwitch = emptyBucket();
  const last = new Map<string, { t: number; read: number; model?: string }>();
  let totalUsd = 0;
  for (const r of records) {
    if (r.role !== 'main' || !r.usage || (filter.model && r.model !== filter.model) || (filter.since && r.date < filter.since)) continue;
    const key = r.session ?? '';
    const t = Date.parse(r.date);
    const prev = last.get(key);
    last.set(key, { t, read: r.usage.cacheRead, model: r.model });
    const { cacheWrite, cacheRead, cost } = r.usage;
    totalUsd += cost.total;
    let cls: MissClass;
    if (cacheWrite < SMALL_WRITE_TOKENS) cls = 'small';
    else if (!prev) cls = 'first';
    else if ((t - prev.t) / 60000 > COLD_GAP_MINUTES && cacheRead < prev.read * 0.5) cls = 'cold';
    else cls = cacheRead < prev.read * 0.5 && cacheRead < cacheWrite ? 'headChange' : 'growth';
    add(byClass[cls], cacheWrite, cost.cacheWrite);
    if (cls === 'headChange') {
      add(byDay[r.date.slice(0, 10)] ??= emptyBucket(), cacheWrite, cost.cacheWrite);
      if (prev?.model && prev.model !== r.model) add(modelSwitch, cacheWrite, cost.cacheWrite);
    }
  }
  return { byClass, byDay, modelSwitch, totalUsd };
}
