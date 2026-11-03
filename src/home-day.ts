import { join } from 'node:path';
import { atomicWrite, readJsonOr } from './store.ts';

/**
 * The App Home's "Hoje": every run that did something today (Brasília), kept in `home-day.json` so a reload does not
 * forget the morning. Pure rendering lives in `renderDay`; the file holds only today's runs.
 */
export interface DayRun { start: number; end: number; about: string; origin: string; steps: number }

const BRT = 3 * 3_600_000;
const FILE = 'home-day.json';
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

/**
 * The "Hoje" block: totals, how long ago the last work ended and the next wake. Not one row per chat run: the Home
 * shows the work as items (src/home-items.ts), and a run is a session, not a piece of work. 03/11: the hour-by-hour bar
 * could not be read on the phone, so the Home says when the last work ended instead.
 */
export function renderDay(runs: readonly DayRun[], now: number, nextWake?: number): string {
  const lines: string[] = [];
  if (runs.length) {
    const total = runs.reduce((s, r) => s + r.end - r.start, 0), ago = now - Math.max(...runs.map(r => r.end));
    const last = ago < 60_000 ? 'agora há pouco' : `há ${duration(ago)}`;
    lines.push(`*Hoje* \u00b7 ${runs.length} trabalho${runs.length === 1 ? '' : 's'} \u00b7 ${duration(total)} trabalhando \u00b7 último ${last}`);
  }
  if (nextWake && nextWake > now) lines.push(`\u23f0 Pr\u00f3xima checagem de wake \u00e0s ${hhmm(nextWake)} (acordo se houver trabalho e voc\u00ea n\u00e3o falar antes)`);
  return lines.filter(Boolean).join('\n');
}
