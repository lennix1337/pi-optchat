import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, readJsonOr } from './store.ts';
import { DAY_MS, readRates, roleKey, ROLE_KEYS, toCall, type Call, type RateTable } from './quota-economy.ts';

/**
 * usage.jsonl is hundreds of MB, so nothing that answers a command may read it. Instead the 5-minute sampler folds the bytes
 * that are new since the last round into a small per-minute aggregate of the profile (provider x role: calls, tokens, US$,
 * tokens without a price), and `cota`, `/cota` and the morning summary read only that. A bucket stands for its minute, so a
 * quota interval is cut to the nearest minute: far below the minutes a reading interval spans.
 */
export const USAGE_AGGREGATE_FILE = 'usage-by-minute.json';
/** How far back the aggregate reaches; a bit over the two weeks the weekly comparison needs. */
export const USAGE_RETENTION_MS = 21 * DAY_MS;
const MINUTE = 60_000;
const CHUNK = 1 << 20;
const DATE = '"date":"', ISO_DATE = /^\d{4}-\d\d-\d\dT/;

/** [minute, provider index, role index, calls, tokens, usd, unpriced tokens] */
type Bucket = [number, number, number, number, number, number, number];
export interface UsageAggregate {
  version: 1;
  /** Byte offset in usage.jsonl up to which the lines are folded in (just after a newline). */
  offset: number;
  /** The aggregate holds every call at or after this time; an earlier one was never read or was pruned. */
  from: number;
  providers: string[];
  buckets: Bucket[];
}

const isBucket = (b: unknown): b is Bucket => Array.isArray(b) && b.length === 7 && b.every(Number.isFinite);
/** The profile's aggregate, or undefined when it is missing, unreadable or of another version. One small JSON file. */
export function readUsageAggregate(dir: string, file = USAGE_AGGREGATE_FILE): UsageAggregate | undefined {
  const data = readJsonOr<Partial<UsageAggregate> | null>(join(dir, file), null);
  if (!data || data.version !== 1 || !Number.isFinite(data.offset) || !Number.isFinite(data.from) || !Array.isArray(data.providers) || !Array.isArray(data.buckets)) return undefined;
  const { providers } = data as UsageAggregate;
  if (!providers.every(p => typeof p === 'string')) return undefined;
  const buckets = data.buckets.filter((b): b is Bucket => isBucket(b) && Number.isInteger(b[1]) && b[1] >= 0 && b[1] < providers.length && Number.isInteger(b[2]) && b[2] >= 0 && b[2] < ROLE_KEYS.length);
  return { version: 1, offset: data.offset!, from: data.from!, providers, buckets };
}

/** The buckets as calls (one per bucket), oldest first, each placed in the middle of its minute. */
export function aggregateCalls(aggregate: UsageAggregate): Call[] {
  return aggregate.buckets.map(([minute, p, r, n, tokens, usd, unpriced]): Call =>
    ({ at: minute * MINUTE + MINUTE / 2, provider: aggregate.providers[p]!, role: ROLE_KEYS[r]!, tokens, usd, calls: n, unpricedTokens: unpriced })).sort((a, b) => a.at - b.at);
}

export interface Scan { calls: Call[]; /** Offset just after the last complete line seen. */ end: number; bytesRead: number }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function lineCall(line: string, sinceIso: string, sinceMs: number, rates: RateTable): { date: string; call?: Call } | undefined {
  const at = line.indexOf(DATE);
  if (at < 0) return undefined;
  const date = line.slice(at + DATE.length, at + DATE.length + 24);
  if (!ISO_DATE.test(date)) return undefined;
  if (date < sinceIso) return { date };
  try { const call = toCall(JSON.parse(line), rates); return { date, call: call && call.at >= sinceMs ? call : undefined }; } catch { return { date }; /* a torn line */ }
}

/**
 * The calls dated at or after `sinceMs`, read from the end of the file backwards in chunks (the newest records are the ones that
 * matter) until a chunk holds only records older than `since` by an hour (they are appended in time order, give or take the
 * seconds a call takes). The event loop gets a turn after every chunk.
 */
export async function scanTail(file: string, sinceMs: number, rates: RateTable): Promise<Scan | undefined> {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return undefined; }
  const calls: Call[] = [], sinceIso = new Date(sinceMs - 3_600_000).toISOString();
  let bytesRead = 0;
  try {
    const size = fstatSync(fd).size;
    // A line still being written has no newline yet: it is neither read now nor counted as folded in.
    const probe = Buffer.alloc(Math.min(size, 64 << 10));
    readSync(fd, probe, 0, probe.length, size - probe.length); bytesRead += probe.length;
    const lastNewline = probe.lastIndexOf(10);
    const end = lastNewline < 0 ? (size === probe.length ? 0 : size - probe.length) : size - probe.length + lastNewline + 1;
    let pos = end, carry = Buffer.alloc(0);
    while (pos > 0) {
      const start = Math.max(0, pos - CHUNK), buf = Buffer.alloc(pos - start);
      readSync(fd, buf, 0, buf.length, start); bytesRead += buf.length;
      let data = Buffer.concat([buf, carry]);
      if (start > 0) { const nl = data.indexOf(10); if (nl < 0) { carry = data; pos = start; continue; } carry = data.subarray(0, nl); data = data.subarray(nl + 1); } else carry = Buffer.alloc(0);
      let newest = '';
      for (const line of data.toString('utf8').split('\n')) {
        const seen = lineCall(line, sinceIso, sinceMs, rates);
        if (!seen) continue;
        if (seen.date > newest) newest = seen.date;
        if (seen.call) calls.push(seen.call);
      }
      pos = start;
      if (newest && newest < sinceIso) break;
      await tick();
    }
    return { calls: calls.sort((a, b) => a.at - b.at), end, bytesRead };
  } finally { closeSync(fd); }
}

/** The calls on the lines that were appended after byte `from`, in chunks, with the event loop getting a turn after each. */
export async function scanFrom(file: string, from: number, sinceMs: number, rates: RateTable): Promise<Scan | undefined> {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return undefined; }
  const calls: Call[] = [], sinceIso = new Date(sinceMs - 3_600_000).toISOString();
  let bytesRead = 0;
  try {
    const size = fstatSync(fd).size;
    let pos = from, carry = Buffer.alloc(0), end = from;
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      readSync(fd, buf, 0, buf.length, pos); bytesRead += buf.length;
      const data = Buffer.concat([carry, buf]), cut = data.lastIndexOf(10);
      pos += buf.length;
      if (cut < 0) { carry = data; continue; }
      carry = data.subarray(cut + 1);
      end = pos - carry.length;
      for (const line of data.subarray(0, cut).toString('utf8').split('\n')) {
        const seen = lineCall(line, sinceIso, sinceMs, rates);
        if (seen?.call) calls.push(seen.call);
      }
      await tick();
    }
    return { calls, end, bytesRead };
  } finally { closeSync(fd); }
}

export interface AggregateOptions {
  dir: string; now?: number; usageFile?: string; ratesFile?: string; retentionMs?: number;
  /** False computes the aggregate without saving it (the report script never writes into a profile). */
  write?: boolean;
  /** Ignore the saved aggregate and read the tail of usage.jsonl again. */
  rebuild?: boolean;
}
export interface AggregateResult { aggregate: UsageAggregate; bytesRead: number }

const emptyAggregate = (offset: number, from: number): UsageAggregate => ({ version: 1, offset, from, providers: [], buckets: [] });

/**
 * Folds what usage.jsonl gained since the last round into the profile's aggregate: only the new bytes are read (the first round,
 * or a log that shrank, reads the tail that the retention needs), and the aggregate is saved when it changed. Undefined when
 * usage.jsonl cannot be opened.
 */
export async function updateUsageAggregate({ dir, now = Date.now(), usageFile = join(dir, 'usage.jsonl'), ratesFile, retentionMs = USAGE_RETENTION_MS, write = true, rebuild = false }: AggregateOptions): Promise<AggregateResult | undefined> {
  const from = now - retentionMs, rates = readRates(ratesFile);
  let kept = rebuild ? undefined : readUsageAggregate(dir);
  let size: number;
  try { const fd = openSync(usageFile, 'r'); try { size = fstatSync(fd).size; } finally { closeSync(fd); } } catch { return undefined; }
  if (kept && kept.offset > size) kept = undefined; // the log was replaced by a shorter one
  const scan = kept ? await scanFrom(usageFile, kept.offset, from, rates) : await scanTail(usageFile, from, rates);
  if (!scan) return undefined;
  const aggregate = kept ?? emptyAggregate(0, from);
  const index = new Map<string, Bucket>(), providers = [...aggregate.providers];
  const key = (b: Bucket) => `${b[0]}|${b[1]}|${b[2]}`;
  for (const b of aggregate.buckets) index.set(key(b), b);
  for (const call of scan.calls) {
    let p = providers.indexOf(call.provider);
    if (p < 0) p = providers.push(call.provider) - 1;
    const probe: Bucket = [Math.floor(call.at / MINUTE), p, ROLE_KEYS.indexOf(roleKey(call.role)), 0, 0, 0, 0];
    const bucket = index.get(key(probe)) ?? probe;
    index.set(key(bucket), bucket);
    bucket[3] += call.calls ?? 1; bucket[4] += call.tokens;
    bucket[5] += call.usd ?? 0; bucket[6] += call.usd === undefined ? call.tokens : 0;
  }
  const coveredFrom = Math.max(aggregate.from, from);
  const buckets = [...index.values()].filter(b => (b[0] + 1) * MINUTE > coveredFrom).sort((a, b) => a[0] - b[0]);
  const next: UsageAggregate = { version: 1, offset: scan.end, from: coveredFrom, providers, buckets };
  const changed = !kept || scan.calls.length > 0 || scan.end !== kept.offset || buckets.length !== aggregate.buckets.length;
  if (write && changed) atomicWrite(join(dir, USAGE_AGGREGATE_FILE), JSON.stringify(next));
  return { aggregate: next, bytesRead: scan.bytesRead };
}
