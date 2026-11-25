import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { brasiliaDayTime } from './pc-health.ts';
import { readQuotaHistory } from './quota-history.ts';
import { paceForecasts, paceText } from './quota-pace.ts';
import type { LocalProbe, ProbeResult } from './prod-health.ts';
import { nonnegative, safeIdentifier } from './diagnostic-metadata.ts';

/** Cached usage only: pi-multi-account owns polling, routing and recovery. Never fetch or switch accounts here. */
export const QUOTA_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'provider-failover-state.json');
export const QUOTA_HEALTH_FILE = 'quota-health.json';
export const QUOTA_NEAR_PERCENT = 90;

export let quotaReadBytes = 0;
const quotaCache = new Map<string, { stamp: string; value: unknown }>();
/** Reads and parses the cached quota file only when its size or mtime changes. */
export function readQuotaState(file = QUOTA_FILE): unknown {
  let stamp: string;
  try { const s = statSync(file); stamp = `${s.size}:${s.mtimeMs}`; } catch { quotaCache.delete(file); return {}; }
  const hit = quotaCache.get(file);
  if (hit?.stamp === stamp) return hit.value;
  let value: unknown = {};
  try { const raw = readFileSync(file, 'utf8'); quotaReadBytes += Buffer.byteLength(raw); value = JSON.parse(raw); } catch { value = {}; }
  if (quotaCache.size >= 16) quotaCache.delete(quotaCache.keys().next().value!);
  quotaCache.set(file, { stamp, value });
  return value;
}

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

/** The plan pi-multi-account cached for a provider ("api-key", "max", "team"...); undefined when unknown. */
export function quotaPlan(provider: string, file = QUOTA_FILE) {
  const plan = record(record(record(readQuotaState(file)).usageByProvider)[provider]).plan;
  return typeof plan === 'string' ? plan : undefined;
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

/** How long a provider's own "usable right now" verdict (`serviceable`) is believed; the same ten minutes pi-multi-account uses. */
export const SERVICEABLE_FRESH_MS = 10 * 60_000;

/**
 * Until when a model route is out of quota, from the cached file alone (undefined when it is free or nothing is known).
 * Mirrors pi-multi-account: a fresh `serviceable: true` frees the provider whatever else is recorded; a fresh `serviceable: false`
 * blocks it for the recheck interval; a window at 100% with a future reset blocks even when the snapshot is stale; a recorded
 * cooldown (per provider, or per `provider/model`) blocks until it ends. Never fetches anything.
 */
export function routeBlock(state: unknown, provider: string, model: string, now: number): number | undefined {
  const data = record(state), usage = record(record(data.usageByProvider)[provider]);
  const fresh = nonnegative(usage.fetchedAt) && now - usage.fetchedAt < SERVICEABLE_FRESH_MS;
  const ends = (...at: unknown[]) => at.filter((value): value is number => future(value, now));
  const byModel = ends(record(data.exhaustedUntilByModel)[`${provider}/${model}`]);
  const byProvider = fresh && usage.serviceable === true ? [] : [
    ...ends(record(data.exhaustedUntilByProvider)[provider]),
    ...windows(usage, now).filter(w => w.usedPercent >= 100).map(w => w.resetAt),
    ...fresh && usage.serviceable === false ? [(usage.fetchedAt as number) + SERVICEABLE_FRESH_MS] : [],
  ];
  const blocked = [...byModel, ...byProvider];
  return blocked.length ? Math.max(...blocked) : undefined;
}

/** Same-family routes the cache does not block, excluding routes explicitly billed by API key. */
export function quotaAlternates(state: unknown, provider: string, model: string, now: number) {
  const usage = record(record(state).usageByProvider);
  const family = Object.hasOwn(usage, provider) ? record(usage[provider]).family : undefined;
  if (typeof family !== 'string' || !family) return [];
  return Object.entries(usage).flatMap(([id, entry]) => {
    const { family: otherFamily, plan } = record(entry);
    return id !== provider && safeIdentifier(id) && otherFamily === family
      && !(typeof plan === 'string' && /^api[-_ ]key\b/i.test(plan)) && routeBlock(state, id, model, now) === undefined ? [id] : [];
  });
}

const describe = (a: Account) => a.blockedUntil ? `${a.id} esgotada até ${brasiliaDayTime(a.blockedUntil)}`
  : `${a.id} ${a.used}% usado (renova ${brasiliaDayTime(a.resetAt!)})`;

/** Meters refresh every 15 minutes at most; one silent for an hour stopped updating and its cached numbers are no longer news. */
export const QUOTA_STALE_MS = 60 * 60_000;

/** Accounts whose meter has a reading older than QUOTA_STALE_MS, with when it was taken. */
export function staleReadings(state: unknown, now: number) {
  return Object.entries(record(record(state).usageByProvider)).flatMap(([id, usage]) => {
    const at = record(usage).fetchedAt;
    return safeIdentifier(id) && nonnegative(at) && now - at > QUOTA_STALE_MS ? [{ id, fetchedAt: at }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function quotaProbe(file = QUOTA_FILE, now: () => number = Date.now): LocalProbe {
  return {
    name: 'Cota dos modelos',
    check(context?: { dir: string }): ProbeResult {
      const state = readQuotaState(file), at = now();
      const all = accounts(state, at), stale = staleReadings(state, at);
      if (!all.length && !stale.length) return { ok: true, ms: 0, detail: 'sem medição válida; disponibilidade desconhecida' };
      const pace = context ? paceForecasts(readQuotaHistory(context.dir), at).filter(f => all.some(a => a.id === f.provider)) : [];
      const detail = `leitura em cache: ${all.map(describe).join('; ')}${pace.length ? ` · ritmo semanal: ${pace.map(f => `${f.provider} ${paceText(f)} (${f.suggestion})`).join('; ')}` : ''}`;
      if (stale.length) return { ok: false, ms: 0, detail, problem: `leitura de cota parada: ${stale.map(s => `${s.id} desde ${brasiliaDayTime(s.fetchedAt)}`).join('; ')}` };
      if (all.some(a => !a.blockedUntil)) return { ok: true, ms: 0, detail };
      return { ok: false, ms: 0, detail, problem: `contas monitoradas esgotadas; a primeira volta ${brasiliaDayTime(Math.min(...all.map(a => a.blockedUntil!)))}` };
    },
  };
}

/** Forecast only; automatic failover remains responsible for keeping work moving. */
export function quotaRisks(state: unknown, now: number): string[] {
  return accounts(state, now).filter(a => !a.blockedUntil && (a.used ?? 0) >= QUOTA_NEAR_PERCENT)
    .map(a => `🪫 cota ${a.id} em ${a.used}% usado (leitura em cache), renova ${brasiliaDayTime(a.resetAt!)}`);
}

export const PROVIDER_LOG_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'provider-failover-debug.log');
export const PROVIDER_LOG_HEALTH_FILE = 'provider-log-health.json';
const LOG_TAIL_BYTES = 1_000_000;
const LOG_REPEATS = 3;

/** Reads the log's tail and flags any `*_failed` event that repeated within the last hour (e.g. a meter that never refreshes). */
export function providerLogProbe(file = PROVIDER_LOG_FILE, now: () => number = Date.now): LocalProbe {
  return {
    name: 'Falhas de provedor no log do Pi',
    check(): ProbeResult {
      let text = '';
      try {
        const fd = openSync(file, 'r');
        try {
          const size = fstatSync(fd).size, start = Math.max(0, size - LOG_TAIL_BYTES), buffer = Buffer.alloc(size - start);
          readSync(fd, buffer, 0, buffer.length, start);
          text = buffer.toString('utf8');
        } finally { closeSync(fd); }
      } catch { return { ok: true, ms: 0, detail: 'log ausente' }; }
      const since = now() - 3_600_000, counts = new Map<string, number>();
      for (const line of text.split('\n')) {
        if (!line.includes('_failed"')) continue;
        try {
          const event = record(JSON.parse(line));
          const kind = event.kind, at = typeof event.t === 'string' ? Date.parse(event.t) : NaN;
          if (typeof kind === 'string' && /^[a-z_]+_failed$/.test(kind) && at >= since) counts.set(kind, (counts.get(kind) ?? 0) + 1);
        } catch {   }
      }
      const repeated = [...counts].filter(([, n]) => n >= LOG_REPEATS);
      if (!repeated.length) return { ok: true, ms: 0, detail: 'sem falha repetida na última hora' };
      return { ok: false, ms: 0, problem: `falha repetida no log do Pi: ${repeated.map(([k, n]) => `${k} ×${n} na última hora`).join('; ')}` };
    },
  };
}
