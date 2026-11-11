import { brasiliaDayTime } from './pc-health.ts';
import { routeBlock } from './quota-health.ts';
import { quotaWindows, type QuotaWindowRow } from './quota-history.ts';
import { ROLE_KEYS, type AccountEconomy, type Economy, type RoleKey, type Spend, type WindowEconomy } from './quota-economy.ts';
import { safeIdentifier } from './diagnostic-metadata.ts';

/** Quota as the operator reads it: per account, `5h X% usado, renova HH:MM · 7d Y% usado, renova dd/mm HH:MM`, in Brasília time. */
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const BRASILIA_MS = 3 * 3_600_000;
const dayOf = (at: number) => new Date(at - BRASILIA_MS).toISOString().slice(0, 10);
/** A reset time: the clock alone when it falls on the same Brasília day as `now` (and `always` is off), else `dd/mm HH:MM`. */
export function resetText(at: number, now: number, always = false): string {
  return !always && dayOf(at) === dayOf(now) ? brasiliaDayTime(at).slice(6) : brasiliaDayTime(at);
}
export const usd = (value: number) => `US$${value.toFixed(2)}`;
export const compactTokens = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));

/** `5h 5% usado, renova 14:59`; a window whose reset time has passed is an old reading, said as such instead of as current use. */
export function windowText(name: '5h' | '7d', w: QuotaWindowRow | undefined, now: number): string | undefined {
  if (!w) return undefined;
  const used = Math.round(w.used * 10) / 10;
  if (w.resetAt <= now) return `${name} ${used}% na última leitura (janela já renovou)`;
  return `${name} ${used}% usado, renova ${resetText(w.resetAt, now, name === '7d')}`;
}

/** What one 1% of the account's windows costs at API prices, when known. */
export function economyText(a: AccountEconomy | undefined): string | undefined {
  const parts = ([['7d', a?.w7d], ['5h', a?.w5h]] as const).flatMap(([name, w]) => w?.usdPerPoint !== undefined ? [`${usd(w.usdPerPoint)} (${name})`] : []);
  return parts.length ? `1% = ${parts.join(', ')}` : undefined;
}

/**
 * One account's line (without its name): both windows with their resets, `esgotada até` when the cache says it cannot serve
 * (a window at 100%, a cooldown, or a fresh `serviceable: false`), `API key, sem limite de cota` for an API-key account.
 */
export function accountText(id: string, state: unknown, now: number, economy?: AccountEconomy): string {
  const usage = record(record(record(state).usageByProvider)[id]), { w5h, w7d } = quotaWindows(usage);
  const until = routeBlock(state, id, '', now);
  const parts = usage.plan === 'api-key' && !w5h && !w7d ? ['API key, sem limite de cota']
    : [windowText('5h', w5h, now), windowText('7d', w7d, now)].filter((p): p is string => Boolean(p));
  if (!parts.length) parts.push(until ? 'sem medição de cota' : 'sem medição');
  if (until) parts.push(`*esgotada até ${resetText(until, now, true)}*`);
  else if (usage.serviceable === false && typeof usage.fetchedAt === 'number') parts.push(`*sem acesso na última leitura* (${brasiliaDayTime(usage.fetchedAt)})`);
  const worth = economyText(economy);
  return [...parts, ...worth ? [worth] : []].join(' · ');
}

/** The ids of every account in the cache (a reading or a cooldown), sorted; unsafe ids never reach a message. */
export function accountIds(state: unknown): string[] {
  const data = record(state);
  return [...new Set([...Object.keys(record(data.usageByProvider)), ...Object.keys(record(data.exhaustedUntilByProvider))])].filter(id => safeIdentifier(id)).sort();
}

/** One bullet per account: the `cota` command, the morning summary and the terminal command share it. */
export function accountLines(state: unknown, now: number, economy?: Economy, label: (id: string) => string = id => id): string[] {
  const ids = accountIds(state);
  if (!ids.length) return ['sem leitura de cota (o pi-multi-account ainda não mediu nenhuma conta)'];
  return ids.map(id => `• ${label(id)}: ${accountText(id, state, now, economy?.accounts.find(a => a.provider === id))}`);
}

const ROLE_LABEL: Record<RoleKey, string> = { main: 'main', subagent: 'subagent', compactor: 'compactor', other: 'outros' };
const spendText = (s: Spend) => `${usd(s.usd)}${s.unpricedTokens ? ` +${compactTokens(s.unpricedTokens)} tokens sem preço` : ''}`;
const signed = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n * 10) / 10}`;

/**
 * The compact weekly block for the 07:00 summary: the last 7 days against the 7 before, API-equivalent US$ per account with the
 * points of its 7d window consumed, then US$ per role. Accounts and roles with no spend in either week are left out.
 */
export function weeklyLines(economy: Economy, label: (id: string) => string = id => id): string[] {
  const [now, before] = economy.weeks;
  if (!now || economy.usageMissing) return [];
  const out: string[] = [];
  for (const id of Object.keys(now.byAccount).sort()) {
    const a = now.byAccount[id]!, b = before?.byAccount[id];
    if (!a.spend.calls && !b?.spend.calls) continue;
    const pts = a.points7d || b?.points7d ? ` · 7d: ${signed(a.points7d)} pts${b ? ` (antes ${signed(b.points7d)})` : ''}` : '';
    out.push(`${label(id)}: ${spendText(a.spend)}${b ? ` (antes ${spendText(b.spend)})` : ''}${pts}`);
  }
  const roles = ROLE_KEYS.filter(k => now.byRole[k].calls || before?.byRole[k].calls)
    .map(k => `${ROLE_LABEL[k]} ${spendText(now.byRole[k])}${before ? ` (antes ${spendText(before.byRole[k])})` : ''}`);
  if (roles.length) out.push(`Por papel: ${roles.join(' · ')}`);
  return out.length ? ['US$ equivalente em API, últimos 7 dias (antes entre parênteses):', ...out] : [];
}

const windowRow = (name: string, w: WindowEconomy | undefined) => w
  ? `${name}: ${signed(w.points)} pts em ${w.intervals} leituras · ${compactTokens(w.tokens)} tokens · ${w.usdPerPoint !== undefined ? `${usd(w.usdPerPoint)} por 1% → janela cheia ${usd(w.fullWindowUsd!)}` : w.points > 0 && w.unpricedTokens ? `sem preço para ${compactTokens(w.unpricedTokens)} tokens (${compactTokens(w.tokensPerPoint!)} tokens por 1%)` : 'sem pontos consumidos ainda'}`
  : `${name}: sem leituras suficientes ainda`;

/** The full report for `scripts/quota-report.mjs` and the terminal `/cota`: every account's quota, its economy and the weekly comparison. */
export function reportText(state: unknown, economy: Economy, label: (id: string) => string = id => id): string {
  const { now } = economy;
  const lines = ['Cota por conta (leitura em cache, horário de Brasília):', ...accountLines(state, now, economy, label)];
  lines.push('', `Histórico de cota: ${economy.since ? `desde ${brasiliaDayTime(economy.since)}` : 'ainda sem leituras'} (os valores por 1% só aparecem depois que a cota anda dentro de um mesmo período).`);
  for (const a of economy.accounts) {
    if (a.plan === 'api-key' || (!a.w5h && !a.w7d)) continue;
    lines.push(`• ${label(a.provider)}`, `   ${windowRow('7d', a.w7d)}`, `   ${windowRow('5h', a.w5h)}`);
  }
  if (economy.usageMissing) lines.push('', 'Gasto em US$ e tokens: o agregado de uso do perfil ainda não existe (o amostrador o cria no próximo ciclo de 5 minutos).');
  else for (const week of economy.weeks) {
    const covered = economy.since !== undefined && economy.since < week.to;
    lines.push('', `Semana ${week.index === 0 ? 'mais recente' : `-${week.index}`} (${brasiliaDayTime(week.from)} → ${brasiliaDayTime(week.to)}):`);
    for (const id of Object.keys(week.byAccount).sort()) {
      const a = week.byAccount[id]!;
      if (!a.spend.calls && !a.points7d && !a.points5h) continue;
      const roles = ROLE_KEYS.filter(k => a.byRole[k].calls).map(k => `${ROLE_LABEL[k]} ${spendText(a.byRole[k])}`).join(', ');
      lines.push(`• ${label(id)}: ${spendText(a.spend)} · ${compactTokens(a.spend.tokens)} tokens · ${a.spend.calls} chamadas · ${covered ? `cota 7d ${signed(a.points7d)} pts, 5h ${signed(a.points5h)} pts` : 'cota sem histórico nesta semana'}${roles ? ` · ${roles}` : ''}`);
    }
    if (week.unattributed.calls) lines.push(`• sem conta registrada: ${spendText(week.unattributed)} · ${compactTokens(week.unattributed.tokens)} tokens`);
    lines.push(`Por papel: ${ROLE_KEYS.map(k => `${ROLE_LABEL[k]} ${spendText(week.byRole[k])}`).join(' · ')}`);
  }
  return lines.join('\n');
}
