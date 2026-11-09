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
export interface MissReport {
  byClass: Record<MissClass, MissBucket>; byDay: Record<string, MissBucket>; modelSwitch: MissBucket; totalUsd: number;
  /** headChange turns by the cause cache-diagnostics.jsonl recorded for the same request: the changed head parts joined with '+', `earlyView` (a view block before its tail changed), `unmatched`. Empty without diagnostics. */
  headCause: Record<string, MissBucket>;
  /** Per day, the first main call of a session after more than IDLE_GAP_MINUTES of silence (or its very first call): what a wake pays to start. */
  afterIdle: Record<string, MissBucket & { medianWriteTokens: number }>;
}
/** One cache-diagnostics.jsonl row (cache.ts ViewReport). */
export interface HeadDiagnostic { date: string; headChanged?: boolean; headParts?: readonly string[]; changedAt?: number | null }

/** The diagnostic row and the usage record of one request are written seconds apart. */
export const DIAGNOSTIC_JOIN_MS = 120_000;

/** Writes below this are normal per-turn growth (new tool output), not a miss. */
export const SMALL_WRITE_TOKENS = 8000;
/** Idle minutes after which the previous turn's cache may be gone; it counts as gone only when the read really fell (a 1-hour entry survives the wait). */
export const COLD_GAP_MINUTES = 5;

/** Silence after which a call counts as the start of a wake or a resumed session. */
export const IDLE_GAP_MINUTES = 10;

const emptyBucket = (): MissBucket => ({ turns: 0, cacheWriteUsd: 0, cacheWriteTokens: 0 });
const add = (b: MissBucket, tokens: number, usd: number) => { b.turns++; b.cacheWriteTokens += tokens; b.cacheWriteUsd += usd; };

/**
 * cold: a large write after an idle gap whose read fell below half of the previous read; a kept prefix after the gap is growth.
 * headChange: a large write while the cache was still warm and the read fell below half of the previous read —
 * the cached prefix changed (view rewrite, tool-set change, model/account switch).
 * growth: a large write with a warm, kept prefix (the conversation simply grew).
 */
export function classifyCacheMisses(records: readonly UsageRecord[], filter: { model?: string; since?: string; diagnostics?: readonly HeadDiagnostic[] } = {}): MissReport {
  const byClass: Record<MissClass, MissBucket> = { small: emptyBucket(), first: emptyBucket(), cold: emptyBucket(), headChange: emptyBucket(), growth: emptyBucket() };
  const byDay: Record<string, MissBucket> = {};
  const modelSwitch = emptyBucket();
  const headCause: Record<string, MissBucket> = {};
  const idleWrites: Record<string, number[]> = {};
  const afterIdle: MissReport['afterIdle'] = {};
  const timed = filter.diagnostics?.map((d) => ({ d, t: Date.parse(d.date) }));
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
    if (!prev || (t - prev.t) / 60000 > IDLE_GAP_MINUTES) {
      const day = r.date.slice(0, 10);
      add(afterIdle[day] ??= { ...emptyBucket(), medianWriteTokens: 0 }, cacheWrite, cost.cacheWrite);
      (idleWrites[day] ??= []).push(cacheWrite);
    }
    let cls: MissClass;
    if (cacheWrite < SMALL_WRITE_TOKENS) cls = 'small';
    else if (!prev) cls = 'first';
    else if ((t - prev.t) / 60000 > COLD_GAP_MINUTES && cacheRead < prev.read * 0.5) cls = 'cold';
    else cls = cacheRead < prev.read * 0.5 && cacheRead < cacheWrite ? 'headChange' : 'growth';
    add(byClass[cls], cacheWrite, cost.cacheWrite);
    if (cls === 'headChange') {
      add(byDay[r.date.slice(0, 10)] ??= emptyBucket(), cacheWrite, cost.cacheWrite);
      if (prev?.model && prev.model !== r.model) add(modelSwitch, cacheWrite, cost.cacheWrite);
      if (timed) add(headCause[causeOf(timed, t)] ??= emptyBucket(), cacheWrite, cost.cacheWrite);
    }
  }
  for (const [day, writes] of Object.entries(idleWrites)) {
    writes.sort((a, b) => a - b);
    const mid = writes.length >> 1;
    afterIdle[day].medianWriteTokens = writes.length % 2 ? writes[mid] : Math.round((writes[mid - 1] + writes[mid]) / 2);
    afterIdle[day].cacheWriteUsd = Math.round(afterIdle[day].cacheWriteUsd * 1e6) / 1e6;
  }
  return { byClass, byDay, modelSwitch, totalUsd, headCause, afterIdle };
}

function causeOf(diagnostics: readonly { d: HeadDiagnostic; t: number }[], t: number): string {
  let best: HeadDiagnostic | undefined, distance = DIAGNOSTIC_JOIN_MS + 1;
  for (const item of diagnostics) {
    const gap = Math.abs(item.t - t);
    if (gap < distance) { distance = gap; best = item.d; }
  }
  if (!best || distance > DIAGNOSTIC_JOIN_MS) return 'unmatched';
  if (best.headChanged) return best.headParts?.length ? best.headParts.join('+') : 'head';
  return best.changedAt != null ? 'earlyView' : 'unmatched';
}
