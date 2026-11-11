import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { accounts, QUOTA_FILE } from './quota-health.ts';
import { readJsonOr } from './store.ts';
import { nonnegative, safeIdentifier } from './diagnostic-metadata.ts';

/**
 * One row per account whenever pi-multi-account's cached reading of it changed (a new `fetchedAt`), so quota percentages can
 * be related to spend afterwards. Reads the cache only: nothing here polls a provider or switches an account.
 */
export const QUOTA_HISTORY_FILE = 'quota-history.jsonl';
/** The live file plus one rotated `.1`: about 4 MB on disk, weeks of rows at one reading per account per five minutes. */
export const QUOTA_HISTORY_MAX_BYTES = 2_000_000;

export interface QuotaWindowRow { used: number; resetAt: number }
export interface QuotaRow {
  /** When the row was written, ms. */
  at: number;
  provider: string;
  plan?: string;
  /** When pi-multi-account measured it, ms: the time the percentages are true for. */
  fetchedAt: number;
  w5h?: QuotaWindowRow;
  w7d?: QuotaWindowRow;
  serviceable?: boolean;
  blockedUntil?: number;
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const HOUR_S = 3600;

/** The two meters of a cached usage entry: `primary` is the short (5 h) window and `secondary` the 7-day one unless `windowSeconds`/`windowMinutes` say otherwise. */
export function quotaWindows(usage: unknown): { w5h?: QuotaWindowRow; w7d?: QuotaWindowRow } {
  const data = record(usage), out: { w5h?: QuotaWindowRow; w7d?: QuotaWindowRow } = {};
  for (const [key, fallback] of [['primary', 'w5h'], ['secondary', 'w7d']] as const) {
    const w = record(data[key]);
    if (!nonnegative(w.usedPercent) || !nonnegative(w.resetAt)) continue;
    const seconds = nonnegative(w.windowSeconds) ? w.windowSeconds : nonnegative(w.windowMinutes) ? w.windowMinutes * 60 : undefined;
    const slot = seconds === undefined ? fallback : seconds <= 24 * HOUR_S ? 'w5h' : 'w7d';
    out[slot] ??= { used: w.usedPercent, resetAt: w.resetAt };
  }
  return out;
}

/** Every row of the history, oldest first (the rotated file first); torn lines are skipped. */
export function readQuotaHistory(dir: string, file = QUOTA_HISTORY_FILE): QuotaRow[] {
  const rows: QuotaRow[] = [];
  for (const path of [join(dir, `${file}.1`), join(dir, file)]) {
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      try {
        const row = JSON.parse(line) as QuotaRow;
        if (typeof row.provider === 'string' && nonnegative(row.fetchedAt) && nonnegative(row.at)) rows.push(row);
      } catch { /* a torn line */ }
    }
  }
  return rows.sort((a, b) => a.fetchedAt - b.fetchedAt || a.at - b.at);
}

/**
 * Appends a row for each account in the cached `state` whose `fetchedAt` is not the one its last row carries, and rotates the
 * file past the size bound. Returns the rows written. Best effort: a full disk must not stop the health round that calls it.
 */
export function sampleQuota(dir: string, state: unknown, now: number, file = QUOTA_HISTORY_FILE, maxBytes = QUOTA_HISTORY_MAX_BYTES): QuotaRow[] {
  const usage = record(record(state).usageByProvider), blocked = new Map(accounts(state, now).map(a => [a.id, a.blockedUntil]));
  const last = new Map<string, number>();
  for (const row of readQuotaHistory(dir, file)) last.set(row.provider, Math.max(last.get(row.provider) ?? 0, row.fetchedAt));
  const rows: QuotaRow[] = [];
  for (const id of Object.keys(usage).sort()) {
    const entry = record(usage[id]);
    if (!safeIdentifier(id) || !nonnegative(entry.fetchedAt) || last.get(id) === entry.fetchedAt) continue;
    const until = blocked.get(id);
    rows.push({ at: now, provider: id, ...typeof entry.plan === 'string' ? { plan: entry.plan } : {}, fetchedAt: entry.fetchedAt, ...quotaWindows(entry),
      ...typeof entry.serviceable === 'boolean' ? { serviceable: entry.serviceable } : {}, ...until === undefined ? {} : { blockedUntil: until } });
  }
  if (!rows.length) return rows;
  try {
    const path = join(dir, file);
    mkdirSync(dir, { recursive: true });
    const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(text) > maxBytes) renameSync(path, `${path}.1`);
    appendFileSync(path, text);
  } catch { return []; }
  return rows;
}

/** One sampling pass from the real cache file, for the health round. */
export const sampleQuotaFromCache = (dir: string, now: number, cache = QUOTA_FILE) => sampleQuota(dir, readJsonOr<unknown>(cache, {}), now);
