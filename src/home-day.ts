import { join } from 'node:path';
import { atomicWrite, readJsonOr } from './store.ts';

/**
 * The App Home's "Hoje": every run that did something today (Brasília), kept in `home-day.json` so a reload does not
 * forget the morning. Pure rendering lives in `renderDay`; the file holds only today's runs.
 */
export interface DayRun { start: number; end: number; about: string; origin: string; steps: number }

const BRT = 3 * 3_600_000;
const FILE = 'home-day.json';
const BARS = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
const day = (at: number) => new Date(at - BRT).toISOString().slice(0, 10);
const hhmm = (at: number) => new Date(at - BRT).toISOString().slice(11, 16);

export function readDay(dir: string, now: number): DayRun[] {
  const runs = readJsonOr<unknown>(join(dir, FILE), []);
  return Array.isArray(runs) ? runs.filter((r): r is DayRun => !!r && typeof r === 'object' && typeof r.start === 'number' && typeof r.end === 'number' && day(r.end) === day(now)) : [];
}

export function recordRun(dir: string, run: DayRun): void {
  atomicWrite(join(dir, FILE), JSON.stringify([...readDay(dir, run.end), run].slice(-200)));
}

const duration = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };

/** Busy minutes per hour of today, from the first busy hour to now, as one bar each. */
export function sparkline(runs: readonly DayRun[], now: number): string {
  if (!runs.length) return '';
  const base = Date.parse(`${day(now)}T00:00:00Z`) + BRT, busy = new Array<number>(24).fill(0);
  for (const r of runs) for (let h = 0; h < 24; h++) {
    const from = Math.max(r.start, base + h * 3_600_000), to = Math.min(r.end, base + (h + 1) * 3_600_000);
    if (to > from) busy[h]! += to - from;
  }
  const first = busy.findIndex(ms => ms > 0), last = Math.floor((now - base) / 3_600_000);
  if (first < 0 || last < first) return '';
  const bars = busy.slice(first, last + 1).map(ms => ms ? BARS[Math.min(7, Math.floor(ms / 3_600_000 * 8))]! : '\u00b7').join('');
  return `\`${String(first).padStart(2, '0')}h ${bars} ${String(last).padStart(2, '0')}h\``;
}

/** The "Hoje" block: totals, the hour-by-hour bar, the latest runs and the next wake. */
export function renderDay(runs: readonly DayRun[], now: number, nextWake?: number): string {
  const lines: string[] = [];
  if (runs.length) {
    const total = runs.reduce((s, r) => s + r.end - r.start, 0), steps = runs.reduce((s, r) => s + r.steps, 0);
    lines.push(`*Hoje* \u00b7 ${runs.length} trabalho${runs.length === 1 ? '' : 's'} \u00b7 ${duration(total)} trabalhando \u00b7 ${steps} passo${steps === 1 ? '' : 's'}`, sparkline(runs, now));
    for (const r of runs.slice(-5).reverse()) lines.push(`\u2022 ${hhmm(r.start)} \u00b7 ${duration(r.end - r.start)} \u00b7 ${r.about.slice(0, 90)}${r.origin === 'terminal' ? '' : ` _(${r.origin})_`}`);
  }
  if (nextWake && nextWake > now) lines.push(`\u23f0 Pr\u00f3xima checagem de wake \u00e0s ${hhmm(nextWake)} (acordo se houver trabalho e voc\u00ea n\u00e3o falar antes)`);
  return lines.filter(Boolean).join('\n');
}
