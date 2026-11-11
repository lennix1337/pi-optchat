import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { QUOTA_FILE } from './quota-health.ts';
import { QUOTA_HISTORY_FILE, readQuotaHistory, type QuotaRow } from './quota-history.ts';
import { nonnegative } from './diagnostic-metadata.ts';
import { readJsonOr } from './store.ts';

/**
 * What one percent of an account's quota is worth in API prices. The quota history says how many points each window consumed
 * between two readings; usage.jsonl says what the calls on that provider in the same interval would cost at API prices. A call
 * recorded with cost 0 (subscription models) is priced from Pi's model registry (`models-store.json`); a model the registry
 * has no price for stays unpriced, and its tokens are reported instead of a made-up dollar figure.
 */
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Two readings belong to one quota period when their reset times differ by less than this (the providers' reset stamp jitters). */
export const SAME_PERIOD_MS = 5 * 60_000;

export type RoleKey = 'main' | 'subagent' | 'compactor' | 'other';
export const ROLE_KEYS: readonly RoleKey[] = ['main', 'subagent', 'compactor', 'other'];
export interface Call { at: number; provider: string; /** The record's role, folded to main/subagent/compactor/other. */ role: RoleKey; tokens: number; /** API-equivalent US$; undefined when no price is known. */ usd?: number }
export interface Spend { calls: number; tokens: number; usd: number; unpricedTokens: number }
export interface Rates { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[] }
/** `provider/model` (the base provider: `openai-codex-account-2` is `openai-codex`) to US$ per million tokens. */
export type RateTable = Map<string, Rates>;

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const baseProvider = (provider: string) => provider.replace(/-account-\d+$/, '');
export const roleKey = (role: unknown): RoleKey => role === 'main' || role === 'subagent' || role === 'compactor' ? role : 'other';
const emptySpend = (): Spend => ({ calls: 0, tokens: 0, usd: 0, unpricedTokens: 0 });
const addSpend = (to: Spend, call: Call) => {
  to.calls++; to.tokens += call.tokens;
  if (call.usd === undefined) to.unpricedTokens += call.tokens; else to.usd += call.usd;
};

const rate = (value: unknown) => nonnegative(value) ? value : 0;
const ratesOf = (value: unknown): Rates | undefined => {
  const c = record(value);
  const base = { input: rate(c.input), output: rate(c.output), cacheRead: rate(c.cacheRead), cacheWrite: rate(c.cacheWrite) };
  if (!base.input && !base.output && !base.cacheRead && !base.cacheWrite) return undefined;
  const tiers = (Array.isArray(c.tiers) ? c.tiers : []).flatMap(t => nonnegative(record(t).inputTokensAbove)
    ? [{ inputTokensAbove: record(t).inputTokensAbove as number, input: rate(record(t).input), output: rate(record(t).output), cacheRead: rate(record(t).cacheRead), cacheWrite: rate(record(t).cacheWrite) }] : []);
  return { ...base, ...tiers.length ? { tiers } : {} };
};

/** Pi's model registry cache (`models-store.json`): per-token prices of every model it lists. Empty when the file is missing. */
export function readRates(file = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'models-store.json')): RateTable {
  const table: RateTable = new Map();
  for (const [provider, entry] of Object.entries(record(readJsonOr<unknown>(file, {})))) {
    const models = record(entry).models;
    for (const model of Array.isArray(models) ? models : []) {
      const m = record(model), rates = ratesOf(m.cost);
      if (typeof m.id === 'string' && rates) table.set(`${provider}/${m.id}`, rates);
    }
  }
  return table;
}

/** Pi's own cost formula (`calculateCost`): the price tier follows the whole request's input size. */
function priced(usage: Record<string, unknown>, rates: Rates): number {
  const input = Number(usage.input) || 0, output = Number(usage.output) || 0, cacheRead = Number(usage.cacheRead) || 0, cacheWrite = Number(usage.cacheWrite) || 0;
  const long = Math.min(Number(usage.cacheWrite1h) || 0, cacheWrite);
  const size = input + cacheRead + cacheWrite;
  let r: Pick<Rates, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> = rates, matched = -1;
  for (const tier of rates.tiers ?? []) if (size > tier.inputTokensAbove && tier.inputTokensAbove > matched) { r = tier; matched = tier.inputTokensAbove; }
  return (r.input * input + r.output * output + r.cacheRead * cacheRead + r.cacheWrite * (cacheWrite - long) + rates.input * 2 * long) / 1e6;
}

/** One usage.jsonl record as a call: its recorded cost when there is one, else the registry's price, else unpriced. Undefined for a record with no usage. */
export function toCall(entry: unknown, rates: RateTable): Call | undefined {
  const e = record(entry), usage = record(e.usage), at = typeof e.date === 'number' ? e.date : Date.parse(String(e.date));
  if (!Object.keys(usage).length || !Number.isFinite(at)) return undefined;
  const parts = ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, k) => sum + (nonnegative(usage[k]) ? usage[k] as number : 0), 0);
  const tokens = nonnegative(usage.totalTokens) && usage.totalTokens > 0 ? usage.totalTokens : parts;
  const provider = typeof e.provider === 'string' ? e.provider : '';
  const recorded = record(usage.cost).total;
  let usd: number | undefined;
  if (nonnegative(recorded) && recorded > 0) usd = recorded;
  else if (!parts) usd = 0;
  else { const r = rates.get(`${baseProvider(provider)}/${String(e.model)}`); if (r) usd = priced(usage, r); }
  return { at, provider, role: roleKey(e.role), tokens, usd };
}

const CHUNK = 4 << 20;
const DATE = '"date":"', ISO_DATE = /^\d{4}-\d\d-\d\dT/;
/**
 * The calls dated after `sinceMs`, read from the end of usage.jsonl in chunks: the file is large (hundreds of MB over time) and
 * the newest records are the only ones a weekly view needs. A chunk is the last one needed once all its records are older than
 * `since` by an hour (records are appended in time order, give or take the seconds a call takes).
 */
export function readCalls(file: string, sinceMs: number, rates: RateTable): Call[] {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return []; }
  const calls: Call[] = [];
  const sinceIso = new Date(sinceMs - 3_600_000).toISOString();
  try {
    let pos = fstatSync(fd).size, carry = Buffer.alloc(0);
    while (pos > 0) {
      const start = Math.max(0, pos - CHUNK), buf = Buffer.alloc(pos - start);
      readSync(fd, buf, 0, buf.length, start);
      let data = Buffer.concat([buf, carry]);
      if (start > 0) { const nl = data.indexOf(10); if (nl < 0) { carry = data; pos = start; continue; } carry = data.subarray(0, nl); data = data.subarray(nl + 1); } else carry = Buffer.alloc(0);
      let newest = '';
      for (const line of data.toString('utf8').split('\n')) {
        const at = line.indexOf(DATE);
        if (at < 0) continue;
        const date = line.slice(at + DATE.length, at + DATE.length + 24);
        if (!ISO_DATE.test(date)) continue;
        if (date > newest) newest = date;
        if (date < sinceIso) continue;
        try { const call = toCall(JSON.parse(line), rates); if (call && call.at >= sinceMs) calls.push(call); } catch { /* a torn line */ }
      }
      pos = start;
      if (newest && newest < sinceIso) break;
    }
  } finally { closeSync(fd); }
  return calls.sort((a, b) => a.at - b.at);
}

export interface WindowEconomy {
  /** Pairs of consecutive readings inside one quota period. */
  intervals: number;
  /** Percentage points consumed over those intervals. */
  points: number;
  tokens: number;
  usd: number;
  unpricedTokens: number;
  /** US$ per 1% of the window; undefined while no point was consumed or some of the tokens have no price. */
  usdPerPoint?: number;
  tokensPerPoint?: number;
  /** API-equivalent of a whole window: 100 x usdPerPoint. */
  fullWindowUsd?: number;
}
export interface AccountEconomy { provider: string; plan?: string; w5h?: WindowEconomy; w7d?: WindowEconomy }
export interface WeekAccount { spend: Spend; byRole: Record<RoleKey, Spend>; points7d: number; points5h: number }
export interface Week {
  /** Exclusive start and inclusive end, ms; `index` 0 is the latest seven days. */
  index: number; from: number; to: number;
  byAccount: Record<string, WeekAccount>;
  byRole: Record<RoleKey, Spend>;
  /** Calls the usage log records without a provider (session overhead). */
  unattributed: Spend;
}
export interface Economy { now: number; since?: number; accounts: AccountEconomy[]; weeks: Week[] }

interface Interval { from: number; to: number; points: number }
/** Points consumed between consecutive readings of one window; a reset (new reset time) or a drop starts a new period and counts nothing, never a negative amount. */
export function intervalsOf(rows: readonly QuotaRow[], key: 'w5h' | 'w7d'): Interval[] {
  const out: Interval[] = [];
  let prev: QuotaRow | undefined;
  for (const row of rows) {
    const w = row[key], p = prev?.[key];
    if (w && p && prev && Math.abs(w.resetAt - p.resetAt) < SAME_PERIOD_MS && w.used >= p.used && row.fetchedAt > prev.fetchedAt)
      out.push({ from: prev.fetchedAt, to: row.fetchedAt, points: w.used - p.used });
    prev = w ? row : undefined;
  }
  return out;
}

/** Cumulative sums over one provider's calls, so any (from, to] interval is two binary searches. */
class Ledger {
  readonly at: number[] = [];
  readonly tokens = [0]; readonly usd = [0]; readonly unpriced = [0]; readonly calls: Call[];
  constructor(calls: Call[]) {
    this.calls = calls;
    for (const c of calls) {
      this.at.push(c.at);
      this.tokens.push(this.tokens.at(-1)! + c.tokens);
      this.usd.push(this.usd.at(-1)! + (c.usd ?? 0));
      this.unpriced.push(this.unpriced.at(-1)! + (c.usd === undefined ? c.tokens : 0));
    }
  }
  /** Number of calls at or before `t`. */
  private upTo(t: number) { let lo = 0, hi = this.at.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (this.at[mid]! <= t) lo = mid + 1; else hi = mid; } return lo; }
  between(from: number, to: number) { const a = this.upTo(from), b = this.upTo(to); return { tokens: this.tokens[b]! - this.tokens[a]!, usd: this.usd[b]! - this.usd[a]!, unpricedTokens: this.unpriced[b]! - this.unpriced[a]! }; }
}

function windowEconomy(intervals: readonly Interval[], ledger: Ledger | undefined): WindowEconomy | undefined {
  if (!intervals.length) return undefined;
  const sum: WindowEconomy = { intervals: intervals.length, points: 0, tokens: 0, usd: 0, unpricedTokens: 0 };
  for (const i of intervals) {
    sum.points += i.points;
    const s = ledger?.between(i.from, i.to);
    if (s) { sum.tokens += s.tokens; sum.usd += s.usd; sum.unpricedTokens += s.unpricedTokens; }
  }
  if (sum.points > 0 && sum.tokens > 0) {
    sum.tokensPerPoint = sum.tokens / sum.points;
    if (sum.unpricedTokens === 0) { sum.usdPerPoint = sum.usd / sum.points; sum.fullWindowUsd = sum.usdPerPoint * 100; }
  }
  return sum;
}

/**
 * The quota economy from the history rows and the priced calls: per account and window the US$ and tokens per 1%, and the last
 * `weeks` weeks (newest first) by account and by role. Pure: the files are read by the caller.
 */
export function analyzeQuota(history: readonly QuotaRow[], calls: readonly Call[], now: number, weeks = 2, providers: readonly string[] = []): Economy {
  const rows = new Map<string, QuotaRow[]>();
  for (const row of history) rows.set(row.provider, [...rows.get(row.provider) ?? [], row]);
  for (const list of rows.values()) list.sort((a, b) => a.fetchedAt - b.fetchedAt);
  const byProvider = new Map<string, Call[]>();
  for (const call of calls) byProvider.set(call.provider, [...byProvider.get(call.provider) ?? [], call]);
  const ledgers = new Map([...byProvider].map(([p, list]) => [p, new Ledger(list.sort((a, b) => a.at - b.at))] as const));
  const ids = [...new Set([...rows.keys(), ...providers])].sort();
  const intervals = new Map(ids.map(id => [id, { w5h: intervalsOf(rows.get(id) ?? [], 'w5h'), w7d: intervalsOf(rows.get(id) ?? [], 'w7d') }] as const));

  const accounts = ids.map((id): AccountEconomy => {
    const plan = [...rows.get(id) ?? []].reverse().find(r => r.plan)?.plan, i = intervals.get(id)!, ledger = ledgers.get(id);
    return { provider: id, ...plan ? { plan } : {}, w5h: windowEconomy(i.w5h, ledger), w7d: windowEconomy(i.w7d, ledger) };
  });

  const slices: Week[] = [];
  for (let index = 0; index < weeks; index++) {
    const to = now - index * WEEK_MS, from = to - WEEK_MS;
    const week: Week = { index, from, to, byAccount: {}, byRole: Object.fromEntries(ROLE_KEYS.map(k => [k, emptySpend()])) as Record<RoleKey, Spend>, unattributed: emptySpend() };
    const account = (id: string) => week.byAccount[id] ??= { spend: emptySpend(), byRole: Object.fromEntries(ROLE_KEYS.map(k => [k, emptySpend()])) as Record<RoleKey, Spend>, points7d: 0, points5h: 0 };
    for (const id of ids) account(id);
    for (const call of calls) {
      if (call.at <= from || call.at > to) continue;
      addSpend(week.byRole[call.role], call);
      if (!call.provider) { addSpend(week.unattributed, call); continue; }
      const a = account(call.provider);
      addSpend(a.spend, call); addSpend(a.byRole[call.role], call);
    }
    for (const id of ids) {
      const a = week.byAccount[id]!;
      for (const i of intervals.get(id)!.w7d) if (i.to > from && i.to <= to) a.points7d += i.points;
      for (const i of intervals.get(id)!.w5h) if (i.to > from && i.to <= to) a.points5h += i.points;
    }
    slices.push(week);
  }
  return { now, since: history[0]?.fetchedAt, accounts, weeks: slices };
}

export interface EconomyFiles { dir: string; now?: number; weeks?: number; cacheFile?: string; ratesFile?: string; usageFile?: string }
/** Reads the profile's history and usage log and the registry's prices, and analyzes them. Read-only. */
export function loadEconomy({ dir, now = Date.now(), weeks = 2, cacheFile = QUOTA_FILE, ratesFile, usageFile = join(dir, 'usage.jsonl') }: EconomyFiles): Economy {
  const history = readQuotaHistory(dir, QUOTA_HISTORY_FILE);
  const cached = Object.keys(record(record(readJsonOr<unknown>(cacheFile, {})).usageByProvider));
  const since = Math.min(now - weeks * WEEK_MS, history[0]?.fetchedAt ?? Infinity);
  return analyzeQuota(history, readCalls(usageFile, since, readRates(ratesFile)), now, weeks, cached);
}

/**
 * `loadEconomy` once per `ttlMs`: it reads a week of usage.jsonl, too much for every `cota` message. A failed read gives
 * `undefined` (the quota lines then simply carry no US$ per 1%), never an error in the command.
 */
export function cachedEconomy(dir: () => string | undefined, ttlMs = 15 * 60_000, weeks = 1, now: () => number = Date.now, files: Partial<EconomyFiles> = {}): () => Economy | undefined {
  let kept: { dir: string; at: number; value: Economy | undefined } | undefined;
  return () => {
    const d = dir(), at = now();
    if (!d) return undefined;
    if (kept?.dir === d && at - kept.at < ttlMs) return kept.value;
    let value: Economy | undefined;
    try { value = loadEconomy({ ...files, dir: d, now: at, weeks }); } catch { value = undefined; }
    kept = { dir: d, at, value };
    return value;
  };
}
