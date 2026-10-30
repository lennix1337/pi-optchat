import { closed, type Commitment } from './commitments.ts';
import { brasiliaTime } from './heartbeat.ts';
import type { HealthState } from './prod-health.ts';

/** What the 07:00 summary knows about an open PR: its CI state, since when, and how often CI changed its mind. */
export interface PrOutlook { title: string; url: string; ci: string; since: number; flips: number }

const HOUR = 3_600_000;
/** A PR whose state has not moved for this long is stuck, not just waiting. */
export const STUCK_MS = 48 * HOUR;
/** Checks pending this long are hung, not running. */
export const HUNG_CI_MS = 2 * HOUR;
/** A PR whose CI went green/red this many times is flaky. */
export const FLAKY_FLIPS = 2;

const ago = (ms: number) => ms >= 48 * HOUR ? `${Math.floor(ms / (24 * HOUR))} dias` : `${Math.max(1, Math.floor(ms / HOUR))} h`;
const ref = (p: PrOutlook) => `<${p.url}|${p.url.replace(/^https:\/\/github\.com\/[^/]+\//, '').replace('/pull/', '#')}> ${p.title}`;

function prRisk(p: PrOutlook, now: number): string | undefined {
  const age = now - p.since;
  if (p.ci === 'FAILURE' || p.ci === 'ERROR') return `❌ CI vermelha há ${ago(age)}: ${ref(p)}`;
  if ((p.ci === 'PENDING' || p.ci === 'EXPECTED') && age >= HUNG_CI_MS) return `⏳ CI pendente há ${ago(age)} (travada?): ${ref(p)}`;
  if (p.flips >= FLAKY_FLIPS) return `🎲 CI instável (mudou ${p.flips}× de verde/vermelho): ${ref(p)}`;
  if (age >= STUCK_MS) return `💤 parado há ${ago(age)}: ${ref(p)}`;
  return undefined;
}

/**
 * What tends to go wrong today, from data already on disk (no model, no network): commitments due in the next 24 h,
 * PRs with red, hung, flaky or stalled CI, and production that is down. Overdue commitments are listed elsewhere.
 */
export function forecast({ commitments, prs, health, now }: { commitments: readonly Commitment[]; prs: readonly PrOutlook[]; health: HealthState; now: number }): string[] {
  const due = commitments
    .filter(c => !closed(c.status) && c.due && Date.parse(c.due) > now && Date.parse(c.due) - now <= 24 * HOUR)
    .sort((a, b) => a.due!.localeCompare(b.due!))
    .map(c => `⏰ vence às ${brasiliaTime(Date.parse(c.due!))}: ${c.text}`);
  const pr = prs.map(p => prRisk(p, now)).filter((l): l is string => !!l);
  const down = Object.entries(health).filter(([, s]) => s.down)
    .map(([name, s]) => `🔴 ${name} fora desde ${brasiliaTime(s.since)} (${s.problem ?? 'sem resposta'}): investigar antes de qualquer deploy`);
  return [...down, ...due, ...pr];
}
