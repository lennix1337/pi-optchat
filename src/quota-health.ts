import { homedir } from 'node:os';
import { join } from 'node:path';
import { brasiliaDayTime } from './pc-health.ts';
import type { LocalProbe, ProbeResult } from './prod-health.ts';
import { readJsonOr } from './store.ts';
import { nonnegative, safeIdentifier } from './diagnostic-metadata.ts';

/** Cached usage only: pi-multi-account owns polling, routing and recovery. Never fetch or switch accounts here. */
export const QUOTA_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'provider-failover-state.json');
export const QUOTA_HEALTH_FILE = 'quota-health.json';
export const QUOTA_NEAR_PERCENT = 90;

interface UsageWindow { usedPercent: number; resetAt: number }
interface Account { id: string; used?: number; resetAt?: number; blockedUntil?: number }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const future = (value: unknown, now: number): value is number => nonnegative(value) && value > now && value <= 8.64e15;

function windows(value: unknown, now: number): UsageWindow[] {
  const usage = record(value);
  return [usage.primary, usage.secondary].flatMap(value => {
    const w = record(value);
    return nonnegative(w.usedPercent) && future(w.resetAt, now)
      ? [{ usedPercent: w.usedPercent, resetAt: w.resetAt }] : [];
  });
}

/** No estimate is made for accounts without a valid, unexpired meter or a current cooldown. */
export function accounts(state: unknown, now: number): Account[] {
  const data = record(state), usage = record(data.usageByProvider), cooldowns = record(data.exhaustedUntilByProvider);
  const ids = new Set([...Object.keys(usage), ...Object.keys(cooldowns)]);
  return [...ids].sort().flatMap(id => {
    if (!safeIdentifier(id)) return [];
    const active = windows(usage[id], now);
    const cooldown = cooldowns[id];
    const blocked = [...active.filter(w => w.usedPercent >= 100).map(w => w.resetAt), ...future(cooldown, now) ? [cooldown] : []];
    if (!active.length && !blocked.length) return [];
    const fullest = active.sort((a, b) => b.usedPercent - a.usedPercent)[0];
    return [{ id, used: fullest?.usedPercent, resetAt: fullest?.resetAt, blockedUntil: blocked.length ? Math.max(...blocked) : undefined }];
  });
}

const describe = (a: Account) => a.blockedUntil ? `${a.id} esgotada até ${brasiliaDayTime(a.blockedUntil)}`
  : `${a.id} ${a.used}% (renova ${brasiliaDayTime(a.resetAt!)})`;

export function quotaProbe(file = QUOTA_FILE, now: () => number = Date.now): LocalProbe {
  return {
    name: 'Cota dos modelos',
    check(): ProbeResult {
      const all = accounts(readJsonOr<unknown>(file, {}), now());
      if (!all.length) return { ok: true, ms: 0, detail: 'sem medição válida; disponibilidade desconhecida' };
      const detail = `leitura em cache: ${all.map(describe).join('; ')}`;
      if (all.some(a => !a.blockedUntil)) return { ok: true, ms: 0, detail };
      return { ok: false, ms: 0, detail, problem: `contas monitoradas esgotadas; a primeira volta ${brasiliaDayTime(Math.min(...all.map(a => a.blockedUntil!)))}` };
    },
  };
}

/** Forecast only; automatic failover remains responsible for keeping work moving. */
export function quotaRisks(state: unknown, now: number): string[] {
  return accounts(state, now).filter(a => !a.blockedUntil && (a.used ?? 0) >= QUOTA_NEAR_PERCENT)
    .map(a => `🪫 cota ${a.id} em ${a.used}% (leitura em cache), renova ${brasiliaDayTime(a.resetAt!)}`);
}
