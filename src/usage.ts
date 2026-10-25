import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { record } from './cache.ts';
import { appendJson } from './store.ts';
import { nonnegative, safeIdentifier } from './diagnostic-metadata.ts';

export type UsageRole = 'main' | 'subagent' | 'compactor' | 'import' | 'advisor' | 'heartbeat';
export type UsageKind = 'conversation' | 'subagent' | 'compaction' | 'session-overhead' | 'import' | 'approval' | 'heartbeat';
export type UsageOutcome = 'stop' | 'toolUse' | 'length' | 'error' | 'aborted' | 'text' | 'tool_call' | 'empty' | 'exception';
export type UsageErrorCategory = 'cancelled' | 'timeout' | 'connection_failure' | 'stream_interrupted' | 'rate_or_usage_limit' | 'authentication' | 'policy_refusal' | 'unavailable' | 'context_limit' | 'other';
export const ranges = ['This session', 'Last hour', 'Today', 'Last 7 days', 'All time'] as const;
export type UsageRange = typeof ranges[number];
export interface UsageEntry {
  id?: string; date: string; role: UsageRole; model: string; provider?: string;
  session?: string; runId?: string; usage: Usage;
  /** Optional attribution fields; omitted by pre-existing ledger records. */
  incidentId?: string; recoveryIncidentId?: string; attempt?: number; kind?: UsageKind; outcome?: UsageOutcome; failed?: boolean; errorCategory?: UsageErrorCategory;
  /** Locally measured request→first content and request→message end, in ms; absent when unmeasured. */
  latency?: Latency;
}
export interface Latency { firstMs?: number; responseMs?: number }
export interface UsageAttribution {
  incidentId?: string; recoveryIncidentId?: string; attempt?: number; outcome?: UsageOutcome; failed?: boolean; errorCategory?: UsageErrorCategory;
}
const usageKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
const costKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const;
const roles: UsageRole[] = ['main', 'subagent', 'compactor', 'import', 'advisor', 'heartbeat'];
const kinds: UsageKind[] = ['conversation', 'subagent', 'compaction', 'session-overhead', 'import', 'approval', 'heartbeat'];
const outcomes: UsageOutcome[] = ['stop', 'toolUse', 'length', 'error', 'aborted', 'text', 'tool_call', 'empty', 'exception'];
const errorCategories = ['cancelled', 'timeout', 'connection_failure', 'stream_interrupted', 'rate_or_usage_limit', 'authentication', 'policy_refusal', 'unavailable', 'context_limit', 'other'];
function validUsage(value: unknown): value is Usage {
  if (!record(value) || !record(value.cost)) return false;
  const cost = value.cost;
  return usageKeys.every(k => nonnegative(value[k])) && costKeys.every(k => nonnegative(cost[k]));
}
const optionalString = (value: unknown) => value === undefined || typeof value === 'string';
const latencyKeys = ['firstMs', 'responseMs'] as const;
const validLatency = (value: unknown): value is Latency => record(value)
  && Object.keys(value).every(k => (latencyKeys as readonly string[]).includes(k)) && latencyKeys.some(k => value[k] !== undefined)
  && latencyKeys.every(k => value[k] === undefined || nonnegative(value[k]));
/** Keeps the measured parts of a timing; undefined when nothing valid was measured. */
function measured(value: Latency): Latency | undefined {
  const kept = Object.fromEntries(latencyKeys.filter(k => nonnegative(value[k])).map(k => [k, Math.round(value[k]!)]));
  return Object.keys(kept).length ? kept : undefined;
}
const stopOutcome = (value: AssistantMessage['stopReason']): UsageOutcome | undefined => outcomes.includes(value as UsageOutcome) ? value as UsageOutcome : undefined;
type MessageEntry = Extract<SessionEntry, { type: 'message' }>;
function backfilledMessage(entry: MessageEntry, session: string, role: 'main' | 'subagent', runId?: string, latency?: Latency): UsageEntry | undefined {
  const { message } = entry;
  if ((message.role !== 'assistant' && message.role !== 'toolResult') || !message.usage) return;
  const failed = message.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'aborted');
  const outcome = message.role === 'assistant' ? stopOutcome(message.stopReason) : undefined;
  return { id: `entry:${entry.id}:${entry.timestamp}`, date: new Date(message.timestamp).toISOString(), role, session, runId,
    provider: message.role === 'assistant' ? message.provider : undefined,
    model: message.role === 'assistant' ? message.model : 'tool-usage-model-unavailable', usage: message.usage,
    kind: role === 'subagent' ? 'subagent' : 'conversation', ...(outcome ? { outcome } : {}), ...(failed ? { failed: true } : {}),
    ...(latency ? { latency } : {}) };
}
function backfilledOverhead(entry: SessionEntry, session: string, role: 'main' | 'subagent', runId?: string): UsageEntry | undefined {
  if ((entry.type !== 'usage' && entry.type !== 'compaction' && entry.type !== 'branch_summary') || !entry.usage) return;
  return { id: `entry:${entry.id}:${entry.timestamp}`, date: entry.timestamp, role, session, runId, model: 'session-overhead',
    kind: entry.type === 'compaction' ? 'compaction' : 'session-overhead', usage: entry.usage };
}
function copyUsage(value: Usage): Usage {
  return {
    input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite,
    totalTokens: value.totalTokens,
    cost: { input: value.cost.input, output: value.cost.output, cacheRead: value.cost.cacheRead, cacheWrite: value.cost.cacheWrite, total: value.cost.total },
  };
}
function validEntry(value: unknown): value is UsageEntry {
  return record(value) && typeof value.date === 'string' && Number.isFinite(Date.parse(value.date))
    && typeof value.role === 'string' && roles.includes(value.role as UsageRole) && typeof value.model === 'string'
    && ['id', 'provider', 'session', 'runId', 'incidentId', 'recoveryIncidentId'].every(k => optionalString(value[k]))
    && (value.attempt === undefined || (typeof value.attempt === 'number' && Number.isSafeInteger(value.attempt) && value.attempt > 0))
    && (value.kind === undefined || (typeof value.kind === 'string' && kinds.includes(value.kind as UsageKind)))
    && (value.outcome === undefined || (typeof value.outcome === 'string' && outcomes.includes(value.outcome as UsageOutcome)))
    && (value.failed === undefined || typeof value.failed === 'boolean')
    && (value.errorCategory === undefined || (typeof value.errorCategory === 'string' && errorCategories.includes(value.errorCategory)))
    && (value.latency === undefined || validLatency(value.latency))
    && validUsage(value.usage);
}
function canonicalEntry(entry: UsageEntry): UsageEntry {
  const parsedDate = Date.parse(entry.date);
  const safe = (value: string | undefined) => safeIdentifier(value) ? value : undefined;
  return {
    ...(safe(entry.id) ? { id: entry.id } : {}), date: new Date(parsedDate).toISOString(), role: entry.role,
    model: safe(entry.model) ? entry.model : 'unknown',
    ...(safe(entry.provider) ? { provider: entry.provider } : {}),
    ...(safe(entry.session) ? { session: entry.session } : {}),
    ...(safe(entry.runId) ? { runId: entry.runId } : {}),
    ...(safe(entry.incidentId) ? { incidentId: entry.incidentId } : {}),
    ...(safe(entry.recoveryIncidentId) ? { recoveryIncidentId: entry.recoveryIncidentId } : {}),
    ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
    ...(entry.kind === undefined ? {} : { kind: entry.kind }),
    ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
    ...(entry.failed === undefined ? {} : { failed: entry.failed }),
    ...(entry.errorCategory === undefined ? {} : { errorCategory: entry.errorCategory }),
    ...(entry.latency === undefined ? {} : { latency: { ...entry.latency } }),
    usage: copyUsage(entry.usage),
  };
}
export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(total: Usage, usage: Usage) {
  for (const key of usageKeys) total[key] += usage[key];
  for (const key of costKeys) total.cost[key] += usage.cost[key];
}

/** Timings waiting for their message's turn-end backfill, keyed by assistant message timestamp; bounded. */
class PendingTimings {
  private readonly byTimestamp = new Map<number, Latency>();
  set(timestamp: number, latency: Latency) {
    const kept = measured(latency);
    if (!kept) return;
    this.byTimestamp.set(timestamp, kept);
    if (this.byTimestamp.size > 256) this.byTimestamp.delete(this.byTimestamp.keys().next().value!);
  }
  take(entry: SessionEntry) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') return;
    const latency = this.byTimestamp.get(entry.message.timestamp);
    this.byTimestamp.delete(entry.message.timestamp);
    return latency;
  }
}

/** Parses one ledger line; undefined for an unreadable or invalid record. */
function parseLine(line: string): UsageEntry | undefined {
  try { const entry: unknown = JSON.parse(line); return validEntry(entry) ? entry : undefined; } catch { return undefined; }
}
function since(range: UsageRange, now: number) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  return range === 'Last hour' ? now - 3600_000 : range === 'Today' ? today.getTime() : range === 'Last 7 days' ? now - 7 * 86400_000 : 0;
}
export type UsageSummary = ReturnType<typeof summarizeUsage> & { calls: number };

/** What the ledger needs from its index over usage.jsonl, the source of truth. */
interface UsageIndex {
  readonly invalid: number;
  /** Appends validated, canonical records whose IDs it has not seen to usage.jsonl and indexes them. */
  append(entries: UsageEntry[]): void;
  all(): UsageEntry[];
  select(range: UsageRange, session: string, now: number): UsageEntry[];
  summary(range: UsageRange, session: string, now: number): UsageSummary;
}

/** Fallback index: reads the whole ledger into memory, so opening grows with the ledger. */
class MemoryIndex implements UsageIndex {
  invalid = 0;
  private readonly entries: UsageEntry[] = [];
  private readonly ids = new Set<string>();
  constructor(private readonly file: string) {
    const contents = existsSync(file) ? readFileSync(file, 'utf8') : '';
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;
      const entry = parseLine(line);
      if (!entry) { this.invalid++; continue; }
      this.push(entry);
    }
  }
  private push(entry: UsageEntry) {
    if (entry.id && this.ids.has(entry.id)) return;
    this.entries.push(entry); if (entry.id) this.ids.add(entry.id);
  }
  append(entries: UsageEntry[]) {
    for (const entry of entries) if (!entry.id || !this.ids.has(entry.id)) { appendJson(this.file, entry); this.push(entry); }
  }
  all() { return [...this.entries]; }
  select(range: UsageRange, session: string, now: number) {
    const from = since(range, now);
    return this.entries.filter(e => range === 'This session' ? e.session === session : range === 'All time' || (Date.parse(e.date) >= from && Date.parse(e.date) <= now));
  }
  summary(range: UsageRange, session: string, now: number): UsageSummary {
    const entries = this.select(range, session, now);
    return { ...summarizeUsage(entries), calls: entries.length };
  }
}

const SCHEMA = '1';
const HOUR = 3600_000;
const amounts = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite', 'costTotal'] as const;
const sums = amounts.map(a => `SUM(${a}) AS ${a}`).join(', ');
const timed = '(firstMs IS NOT NULL OR responseMs IS NOT NULL)';
const sqlite = (() => { try { return process.getBuiltinModule('node:sqlite'); } catch { return undefined; } })();
type Group = Record<typeof amounts[number], number> & { role: UsageRole; provider: string; model: string; first: number; calls: number; failures: number };
/** Hash of the 4 KiB before `offset`: tells whether the ledger still holds the bytes the index has read. */
function fingerprint(file: string, offset: number) {
  const start = Math.max(0, offset - 4096), block = Buffer.alloc(offset - start), fd = openSync(file, 'r');
  try { readSync(fd, block, 0, block.length, start); } finally { closeSync(fd); }
  return createHash('sha256').update(block).digest('hex');
}

/** usage.db: a disposable SQLite index over usage.jsonl, which stays the only copy of each record. The index keeps each record's
 * byte range, the columns the usage page aggregates, and hourly totals; it reads only the bytes the ledger gained since its last
 * read, and rebuilds itself when missing, unreadable, of another schema, or when the ledger no longer holds what it read.
 * Each operation opens and closes the database, so no handle outlives a call and other processes' appends are picked up. */
class SqliteIndex implements UsageIndex {
  invalid = 0;
  constructor(private readonly file: string, private readonly db: string) { this.use(() => {}); }
  private reset() { for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(this.db + suffix, { force: true }); }
  private open() {
    const db = new sqlite!.DatabaseSync(this.db, { timeout: 5000 });
    try {
      // synchronous=OFF: a write lost to an OS crash only costs a rebuild from the ledger.
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS entries(n INTEGER PRIMARY KEY, id TEXT UNIQUE, pos INTEGER NOT NULL, len INTEGER NOT NULL, ts INTEGER NOT NULL,
          session TEXT, role TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, failed INTEGER NOT NULL, firstMs REAL, responseMs REAL,
          ${amounts.map(a => `${a} REAL NOT NULL`).join(', ')});
        CREATE INDEX IF NOT EXISTS entries_ts ON entries(ts);
        CREATE INDEX IF NOT EXISTS entries_session ON entries(session);
        CREATE INDEX IF NOT EXISTS entries_timed ON entries(ts) WHERE ${timed};
        CREATE TABLE IF NOT EXISTS hours(hour INTEGER NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
          first INTEGER NOT NULL, calls INTEGER NOT NULL, failures INTEGER NOT NULL, ${amounts.map(a => `${a} REAL NOT NULL`).join(', ')},
          PRIMARY KEY(hour, role, provider, model)) WITHOUT ROWID;
        INSERT OR IGNORE INTO meta VALUES ('schema', '${SCHEMA}');`);
      if (this.meta(db, 'schema') !== SCHEMA) throw new Error('usage.db has another schema');
      return db;
    } catch (error) { db.close(); throw error; }
  }
  private meta(db: DatabaseSync, key: string) { return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value; }
  private setMeta(db: DatabaseSync, key: string, value: string | number) { db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(key, String(value)); }
  /** Runs `work` on a database synced with the ledger; an index that cannot be opened or synced is deleted and rebuilt once. */
  private use<T>(work: (db: DatabaseSync) => T): T {
    let db: DatabaseSync | undefined;
    for (let attempt = 1; !db; attempt++) {
      try { db = this.open(); this.sync(db); }
      catch (error) {
        db?.close(); db = undefined;
        if (attempt === 2) throw error;
        this.reset();
      }
    }
    try { return work(db); } finally { db.close(); }
  }
  private sync(db: DatabaseSync) {
    const size = existsSync(this.file) ? statSync(this.file).size : 0;
    let offset = Number(this.meta(db, 'offset') ?? 0);
    if (offset > size || (offset > 0 && fingerprint(this.file, offset) !== this.meta(db, 'tail'))) {
      db.exec("DELETE FROM entries; DELETE FROM hours; DELETE FROM meta WHERE key IN ('offset', 'tail', 'invalid')");
      offset = 0;
    }
    this.invalid = Number(this.meta(db, 'invalid') ?? 0);
    if (size === offset) return;
    const block = Buffer.alloc(size - offset), fd = openSync(this.file, 'r');
    try { readSync(fd, block, 0, block.length, offset); } finally { closeSync(fd); }
    // A last line without its newline is still being written; it is read once it ends.
    const end = block.lastIndexOf(0x0a) + 1;
    if (!end) return;
    const insert = db.prepare(`INSERT OR IGNORE INTO entries(id, pos, len, ts, session, role, provider, model, failed, firstMs, responseMs, ${amounts.join(', ')})
      VALUES (${Array(amounts.length + 11).fill('?').join(', ')})`);
    const last = Number((db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM entries').get() as { n: number }).n);
    db.exec('BEGIN');
    try {
      for (let start = 0, newline; start < end; start = newline + 1) {
        newline = block.indexOf(0x0a, start);
        const line = block.toString('utf8', start, newline);
        if (!line.trim()) continue;
        const e = parseLine(line);
        if (!e) { this.invalid++; continue; }
        const u = e.usage, c = u.cost;
        insert.run(e.id ?? null, offset + start, newline - start, Date.parse(e.date), e.session ?? null, e.role, e.provider ?? '', e.model,
          e.failed ? 1 : 0, e.latency?.firstMs ?? null, e.latency?.responseMs ?? null,
          u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens, c.input, c.output, c.cacheRead, c.cacheWrite, c.total);
      }
      db.prepare(`INSERT INTO hours SELECT ts / ${HOUR}, role, provider, model, MIN(n), COUNT(*), SUM(failed), ${sums}
        FROM entries WHERE n > ? GROUP BY 1, 2, 3, 4
        ON CONFLICT DO UPDATE SET first = MIN(first, excluded.first), calls = calls + excluded.calls, failures = failures + excluded.failures,
          ${amounts.map(a => `${a} = ${a} + excluded.${a}`).join(', ')}`).run(last);
      this.setMeta(db, 'offset', offset + end);
      this.setMeta(db, 'tail', fingerprint(this.file, offset + end));
      this.setMeta(db, 'invalid', this.invalid);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  append(entries: UsageEntry[]) {
    if (!entries.length) return;
    const fresh = this.use(db => {
      const known = db.prepare('SELECT 1 FROM entries WHERE id = ?');
      return entries.filter(entry => !entry.id || !known.get(entry.id));
    });
    if (!fresh.length) return;
    for (const entry of fresh) appendJson(this.file, entry);
    this.use(() => {});
  }
  /** The records of the matching rows, read back from the ledger in one pass over the bytes they span. */
  private records(where: string, params: (string | number)[]) {
    return this.use(db => {
      const rows = db.prepare(`SELECT pos, len FROM entries ${where} ORDER BY n`).all(...params) as { pos: number; len: number }[];
      if (!rows.length) return [];
      const from = Math.min(...rows.map(r => r.pos)), to = Math.max(...rows.map(r => r.pos + r.len));
      const block = Buffer.alloc(to - from), fd = openSync(this.file, 'r');
      try { readSync(fd, block, 0, block.length, from); } finally { closeSync(fd); }
      return rows.flatMap(r => parseLine(block.toString('utf8', r.pos - from, r.pos - from + r.len)) ?? []);
    });
  }
  all() { return this.records('', []); }
  select(range: UsageRange, session: string, now: number) {
    if (range === 'This session') return this.records('WHERE session = ?', [session]);
    if (range === 'All time') return this.all();
    return this.records('WHERE ts >= ? AND ts <= ?', [since(range, now), now]);
  }
  /** Same result as summarizeUsage(select(...)) without reading the records: whole hours come from the hourly totals, the partial
   * hours at either end and "This session" from the rows, and medians from the few rows that carry a measured latency. */
  summary(range: UsageRange, session: string, now: number): UsageSummary {
    return this.use(db => {
      const rows = (where: string, ...params: (string | number)[]) => db.prepare(`SELECT role, provider, model, MIN(n) AS first, COUNT(*) AS calls,
        SUM(failed) AS failures, ${sums} FROM entries ${where} GROUP BY role, provider, model`).all(...params) as Group[];
      const hours = (where: string, ...params: number[]) => db.prepare(`SELECT role, provider, model, MIN(first) AS first, SUM(calls) AS calls,
        SUM(failures) AS failures, ${sums} FROM hours ${where} GROUP BY role, provider, model`).all(...params) as Group[];
      let parts: Group[], latencyWhere: string, latencyParams: (string | number)[];
      if (range === 'This session') { parts = rows('WHERE session = ?', session); latencyWhere = `session = ? AND ${timed}`; latencyParams = [session]; }
      else if (range === 'All time') { parts = hours(''); latencyWhere = timed; latencyParams = []; }
      else {
        const from = since(range, now), low = Math.ceil(from / HOUR), high = Math.floor((now + 1) / HOUR);
        parts = low < high
          ? [...hours('WHERE hour >= ? AND hour < ?', low, high), ...rows('WHERE ts >= ? AND ts < ?', from, low * HOUR), ...rows('WHERE ts >= ? AND ts <= ?', high * HOUR, now)]
          : rows('WHERE ts >= ? AND ts <= ?', from, now);
        latencyWhere = `ts >= ? AND ts <= ? AND ${timed}`; latencyParams = [from, now];
      }
      const key = (g: { role: string; provider: string; model: string }) => JSON.stringify([g.role, g.provider, g.model]);
      const groups = new Map<string, { group: Group; usage: Usage; samples: LatencySamples }>();
      for (const part of parts) {
        const usage: Usage = { input: part.input, output: part.output, cacheRead: part.cacheRead, cacheWrite: part.cacheWrite, totalTokens: part.totalTokens,
          cost: { input: part.costInput, output: part.costOutput, cacheRead: part.costCacheRead, cacheWrite: part.costCacheWrite, total: part.costTotal } };
        const known = groups.get(key(part));
        if (!known) { groups.set(key(part), { group: { ...part }, usage, samples: new LatencySamples() }); continue; }
        known.group.first = Math.min(known.group.first, part.first); known.group.calls += part.calls; known.group.failures += part.failures;
        addUsage(known.usage, usage);
      }
      const all = new LatencySamples();
      for (const row of db.prepare(`SELECT role, provider, model, firstMs, responseMs FROM entries WHERE ${latencyWhere}`).all(...latencyParams) as
        { role: string; provider: string; model: string; firstMs: number | null; responseMs: number | null }[]) {
        const latency = { ...(row.firstMs === null ? {} : { firstMs: row.firstMs }), ...(row.responseMs === null ? {} : { responseMs: row.responseMs }) };
        groups.get(key(row))?.samples.add(latency); all.add(latency);
      }
      const total = emptyUsage();
      let failures = 0, calls = 0;
      const result = [...groups.values()].sort((a, b) => a.group.first - b.group.first).map(({ group, usage, samples }) => {
        addUsage(total, usage); failures += group.failures; calls += group.calls;
        return { role: group.role, provider: group.provider || undefined, model: group.model, usage, calls: group.calls, failures: group.failures,
          latency: samples.summary() };
      });
      return { total, failures, latency: all.summary(), groups: result, calls };
    });
  }
}

/** A torn last line becomes one unreadable record instead of swallowing the next append. */
function endLastLine(file: string) {
  const size = existsSync(file) ? statSync(file).size : 0, last = Buffer.alloc(1);
  if (!size) return;
  const fd = openSync(file, 'r');
  try { readSync(fd, last, 0, 1, size - 1); } finally { closeSync(fd); }
  if (last[0] !== 0x0a) appendFileSync(file, '\n');
}

/** The SQLite index when this Node has node:sqlite and it opens; otherwise a full read, with a note saying why. */
function openIndex(file: string, useSqlite: boolean, notes: string[]): UsageIndex {
  if (sqlite && useSqlite) try { return new SqliteIndex(file, file.replace(/\.jsonl$/, '.db')); }
  catch (error) { notes.push(`usage.db unavailable, reading usage.jsonl in full: ${error instanceof Error ? error.message : String(error)}`); }
  return new MemoryIndex(file);
}

/** One profile's ledger. Stable message IDs make resume/backfill idempotent. usage.jsonl stays the append-only source of truth;
 * usage.db indexes it when Node has node:sqlite, so opening a profile no longer reads the whole ledger. */
export class UsageLedger {
  private rejected = 0;
  private readonly notes: string[] = [];
  private readonly cursors = new Map<string, number>();
  private readonly timings = new PendingTimings();
  private readonly file: string;
  private readonly index: UsageIndex;
  constructor(directory: string, options: { sqlite?: boolean } = {}) {
    this.file = join(directory, 'usage.jsonl');
    endLastLine(this.file);
    this.index = openIndex(this.file, options.sqlite !== false, this.notes);
  }
  /** Every record, in ledger order. Reads the whole ledger: for tests and tools, not for opening a profile. */
  get entries() { return this.index.all(); }
  get warnings() {
    const invalid = this.index.invalid + this.rejected;
    return [...this.notes, ...invalid ? [`${invalid} unreadable usage records excluded; totals may be incomplete.`] : []];
  }
  add(entry: UsageEntry) { this.addAll([entry]); }
  private addAll(entries: UsageEntry[]) {
    const fresh: UsageEntry[] = [], ids = new Set<string>();
    for (const entry of entries) {
      if (!validEntry(entry)) { this.rejected++; continue; }
      const safeEntry = canonicalEntry(entry);
      if (safeEntry.id && ids.has(safeEntry.id)) continue;
      fresh.push(safeEntry); if (safeEntry.id) ids.add(safeEntry.id);
    }
    this.index.append(fresh);
  }
  compression(message: AssistantMessage, role: 'compactor' | 'import' | 'advisor' | 'heartbeat', session: string, attribution: UsageAttribution = {}) {
    const hasText = message.content.some(block => block.type === 'text' && block.text.trim());
    const hasToolCall = message.content.some(block => block.type === 'toolCall');
    const failed = attribution.failed ?? (message.stopReason === 'error' || message.stopReason === 'aborted' || message.stopReason === 'length' || !hasText || hasToolCall);
    this.add({ id: randomUUID(), date: new Date(message.timestamp).toISOString(), role, session,
      provider: message.provider, model: message.model, usage: message.usage,
      kind: role === 'import' ? 'import' : role === 'advisor' ? 'approval' : role === 'heartbeat' ? 'heartbeat' : 'compaction',
      outcome: attribution.outcome ?? (hasToolCall ? 'tool_call' : hasText ? stopOutcome(message.stopReason) : 'empty'),
      failed,
      ...(attribution.incidentId === undefined ? {} : { incidentId: attribution.incidentId }),
      ...(attribution.recoveryIncidentId === undefined ? {} : { recoveryIncidentId: attribution.recoveryIncidentId }),
      ...(attribution.attempt === undefined ? {} : { attempt: attribution.attempt }),
      ...(attribution.errorCategory === undefined ? {} : { errorCategory: attribution.errorCategory }),
    });
  }
  /** Records the measured latency of the assistant message created at `timestamp`; invalid parts are dropped. */
  timing(timestamp: number, latency: Latency) { this.timings.set(timestamp, latency); }
  backfill(entries: SessionEntry[], session: string, role: 'main' | 'subagent' = 'main', runId?: string) {
    const cursorKey = `${session}:${runId ?? ''}`;
    const cursor = this.cursors.get(cursorKey) ?? 0, found: UsageEntry[] = [];
    for (const entry of entries.slice(cursor <= entries.length ? cursor : 0)) {
      // Pi forks preserve entry IDs/timestamps. Never count inherited responses twice.
      const usage = entry.type === 'message' ? backfilledMessage(entry, session, role, runId, this.timings.take(entry)) : backfilledOverhead(entry, session, role, runId);
      if (usage) found.push(usage);
    }
    this.addAll(found);
    this.cursors.set(cursorKey, entries.length);
  }
  select(range: UsageRange, session: string, now = Date.now()) { return this.index.select(range, session, now); }
  /** The usage page's totals for a range, computed by the index. */
  summary(range: UsageRange, session: string, now = Date.now()) { return this.index.summary(range, session, now); }
}

const median = (values: number[]) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
export interface LatencySummary { calls: number; firstMs?: number; responseMs?: number }
class LatencySamples {
  private readonly first: number[] = [];
  private readonly response: number[] = [];
  add(latency?: Latency) {
    if (latency?.firstMs !== undefined) this.first.push(latency.firstMs);
    if (latency?.responseMs !== undefined) this.response.push(latency.responseMs);
  }
  summary(): LatencySummary | undefined {
    const calls = Math.max(this.first.length, this.response.length);
    if (!calls) return undefined;
    const firstMs = median(this.first), responseMs = median(this.response);
    return { calls, ...(firstMs === undefined ? {} : { firstMs }), ...(responseMs === undefined ? {} : { responseMs }) };
  }
}
export function summarizeUsage(entries: UsageEntry[]) {
  const total = emptyUsage(), samples = new LatencySamples();
  const groups = new Map<string, { role: UsageRole; provider?: string; model: string; usage: Usage; calls: number; failures: number; samples: LatencySamples }>();
  let failures = 0;
  for (const entry of entries) {
    // Provider is part of a model's identity; legacy records without it remain grouped under unknown.
    const key = JSON.stringify([entry.role, entry.provider ?? '', entry.model]);
    let group = groups.get(key);
    if (!group) { group = { role: entry.role, provider: entry.provider, model: entry.model, usage: emptyUsage(), calls: 0, failures: 0, samples: new LatencySamples() }; groups.set(key, group); }
    group.calls++;
    addUsage(group.usage, entry.usage); addUsage(total, entry.usage);
    group.samples.add(entry.latency); samples.add(entry.latency);
    if (entry.failed) { group.failures++; failures++; }
  }
  return { total, failures, latency: samples.summary(),
    groups: [...groups.values()].map(({ samples: groupSamples, ...group }) => ({ ...group, latency: groupSamples.summary() })) };
}
