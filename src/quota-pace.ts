import { SAME_PERIOD_MS, WEEK_MS } from './quota-economy.ts';
import type { QuotaRow, QuotaWindowRow } from './quota-history.ts';

/**
 * Weekly-quota pacing: will an account reach its 7-day reset with quota unused? A week's quota that is not spent is wasted, so
 * below the target the harness should work more (think harder, spawn more) and past 100% less. Pure: the history rows and the
 * clock come from the caller; nothing here reads a file or touches a provider.
 */
export const PACE_TARGET_PCT = 95;
/** The burn rate is the slope of the readings of this long before the latest one, inside the current window. */
export const PACE_RECENT_MS = 24 * 3_600_000;
/** Readings closer together than this say nothing about a rate (the meters move in whole percent). */
export const PACE_MIN_SPAN_MS = 2 * 3_600_000;
const HOUR_MS = 3_600_000;

export const PACE_UNDER_SUGGESTION = 'sobra cota: aumente thinking / spawn mais';
export const PACE_OVER_SUGGESTION = 'vai estourar antes do reset: reduza thinking / spawn menos';
const PACE_ON_SUGGESTION = 'no ritmo: mantenha';

export type PaceVerdict = 'under' | 'on-track' | 'over';
export interface PaceForecast {
  provider: string;
  /** The weekly meter at the latest reading, %. */
  used: number;
  resetAt: number;
  /** Where the meter will be at the reset if the burn rate holds, % (above 100 means the limit is hit first). */
  projectedAtReset: number;
  /** `under` below the 95% target, `over` at 100% or more, `on-track` between. */
  verdict: PaceVerdict;
  /** Room left at the reset, in points (negative: by how much the limit is overshot); 0 when already exhausted. */
  headroomPct: number;
  suggestion: string;
  /** `recent`: the last 24 hours; `window`: the average since the window opened (too few recent readings); `exhausted`. */
  basis: 'recent' | 'window' | 'exhausted';
  /** Points per hour the projection assumes, and hours from the latest reading to the reset. */
  ratePerHour: number;
  hoursLeft: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * One account's forecast from its history rows (any order). Only readings of the window that holds the latest one count, so a
 * reset inside the history never mixes two weeks. Undefined without a 7-day meter, when the latest reading is of a window that
 * has already ended, or when there is not enough of the window behind it to say anything.
 */
export function forecastPace(rows: readonly QuotaRow[], now: number): PaceForecast | undefined {
  const weekly = rows.filter(r => r.w7d).sort((a, b) => a.fetchedAt - b.fetchedAt || a.at - b.at);
  const latest = weekly.at(-1);
  const window = latest?.w7d;
  if (!latest || !window || window.resetAt <= now) return undefined;
  const base = { provider: latest.provider, used: window.used, resetAt: window.resetAt };
  const hoursLeft = Math.max(0, (window.resetAt - latest.fetchedAt) / HOUR_MS);
  if (window.used >= 100) return { ...base, projectedAtReset: 100, verdict: 'over', headroomPct: 0, suggestion: PACE_OVER_SUGGESTION, basis: 'exhausted', ratePerHour: 0, hoursLeft };

  const period = weekly.filter(r => Math.abs(r.w7d!.resetAt - window.resetAt) < SAME_PERIOD_MS);
  const first = period.find(r => r.fetchedAt >= latest.fetchedAt - PACE_RECENT_MS)!;
  const span = latest.fetchedAt - first.fetchedAt;
  let ratePerHour: number, basis: 'recent' | 'window';
  if (span >= PACE_MIN_SPAN_MS) { ratePerHour = (window.used - first.w7d!.used) / (span / HOUR_MS); basis = 'recent'; }
  else {
    const elapsed = latest.fetchedAt - (window.resetAt - WEEK_MS);
    if (elapsed < PACE_MIN_SPAN_MS) return undefined;
    ratePerHour = window.used / (elapsed / HOUR_MS); basis = 'window';
  }
  ratePerHour = Math.max(0, ratePerHour);
  const projectedAtReset = round1(window.used + ratePerHour * hoursLeft);
  const verdict: PaceVerdict = projectedAtReset >= 100 ? 'over' : projectedAtReset >= PACE_TARGET_PCT ? 'on-track' : 'under';
  const suggestion = verdict === 'under' ? PACE_UNDER_SUGGESTION : verdict === 'over' ? PACE_OVER_SUGGESTION : PACE_ON_SUGGESTION;
  return { ...base, projectedAtReset, verdict, headroomPct: round1(100 - projectedAtReset), suggestion, basis, ratePerHour, hoursLeft };
}

/** One forecast per account that has a live weekly meter, sorted by account id. */
export function paceForecasts(history: readonly QuotaRow[], now: number): PaceForecast[] {
  const by = new Map<string, QuotaRow[]>();
  for (const row of history) (by.get(row.provider) ?? by.set(row.provider, []).get(row.provider)!).push(row);
  return [...by].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, rows]) => forecastPace(rows, now) ?? []);
}

/** The card and account-line wording: `projeção: 47% no reset`. */
export const paceText = (f: Pick<PaceForecast, 'projectedAtReset'>) => `projeção: ${Math.round(f.projectedAtReset)}% no reset`;

/** What the agent reads when it wakes: the accounts that will waste quota or overshoot it, or undefined when all are on track. */
export function paceWakeNote(forecasts: readonly PaceForecast[], label: (id: string) => string = id => id): string | undefined {
  const lines = forecasts.filter(f => f.verdict !== 'on-track').map(f => `• ${label(f.provider)}: ${paceText(f)} — ${f.suggestion}`);
  return lines.length ? ['Ritmo da cota semanal (burn das últimas 24 h projetado até o reset; meta ~95%):', ...lines].join('\n') : undefined;
}

/** Wake-interval bounds in minutes. The defaults are neutral: a 30-minute base that stretches to 2 hours or shrinks to 10 minutes. */
export interface PaceConfig { baseMin?: number; floorMin?: number; ceilMin?: number }
export const PACE_DEFAULTS = { baseMin: 30, floorMin: 10, ceilMin: 120 } as const;
export interface PaceControl {
  projectedPct: number;
  pace: 'under' | 'on' | 'over';
  wakeIntervalMin: number;
  thinkingHint: 'raise' | 'keep' | 'lower';
}

/**
 * How often to wake given one account's weekly forecast. `windows` is the live meter from the quota cache (it counts as a
 * reading taken now); `history` is that account's rows. With quota to spare the interval is the base divided by how much faster
 * the allowed rate (what is left of the 95% target over the time left) is than the current burn, so it shortens as the reset
 * nears and the surplus grows, down to the floor; on target it is the base; when the week will be overshot it lengthens by the
 * same ratio up to the ceiling. Undefined when there is no forecast, which leaves the caller's own interval alone.
 */
export function paceControl(windows: { w7d?: QuotaWindowRow }, history: readonly QuotaRow[], now: number, config: PaceConfig = {}): PaceControl | undefined {
  const rows = windows.w7d
    ? [...history.filter(r => r.fetchedAt < now), { at: now, provider: history.at(-1)?.provider ?? '', fetchedAt: now, w7d: windows.w7d }]
    : history;
  const f = forecastPace(rows, now);
  if (!f) return undefined;
  const baseMin = config.baseMin ?? PACE_DEFAULTS.baseMin;
  const floorMin = Math.min(config.floorMin ?? PACE_DEFAULTS.floorMin, baseMin), ceilMin = Math.max(config.ceilMin ?? PACE_DEFAULTS.ceilMin, baseMin);
  const allowed = Math.max(0, (PACE_TARGET_PCT - f.used) / Math.max(f.hoursLeft, 1 / 60));
  const ratio = f.basis === 'exhausted' ? 0 : f.ratePerHour > 0 ? allowed / f.ratePerHour : Infinity;
  const scaled = Math.round(baseMin / ratio);
  const pace = f.verdict === 'on-track' ? 'on' : f.verdict;
  const wakeIntervalMin = pace === 'on' ? baseMin : pace === 'under' ? Math.max(floorMin, Math.min(baseMin, scaled)) : Math.min(ceilMin, Math.max(baseMin, scaled));
  return { projectedPct: f.projectedAtReset, pace, wakeIntervalMin, thinkingHint: pace === 'under' ? 'raise' : pace === 'over' ? 'lower' : 'keep' };
}
