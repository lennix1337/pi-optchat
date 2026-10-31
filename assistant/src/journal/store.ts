import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseOutcomeInput, parseSignal, type Outcome, type OutcomeInput, type Signal } from '../contracts/signals.ts';
import { immediate } from '../store/transaction.ts';
import { decideReflex, type ReflexAction, type ReflexRule } from './rules.ts';

const DAY = 86_400_000;

export type StoredSignal = Signal & { sequence: number; receivedAt: number };
export type DecisionRecord = {
  ruleId: string; action: ReflexAction; reason: string; category: string | null;
  decidedAt: number; latencyMs: number; modelCalls: number;
};
export type SignalRow = StoredSignal & { decision: DecisionRecord | null };
export type SignalPage = { signals: SignalRow[]; nextCursor: number | null };
export type OutcomePage = { outcomes: Outcome[]; nextCursor: number | null };
export type JournalMetrics = {
  from: number; to: number; total: number;
  bySource: Record<string, number>; byKind: Record<string, number>;
  notify: number; resolve: number; ignore: number;
  handledWithoutModel: number; turnsAvoided: number;
  resolutionRate: number | null; p50DecisionMs: number | null; p95DecisionMs: number | null;
  modelCalls: number; duplicates: number;
};
export type OutcomeSummary = {
  total: number; verified: number; notVerified: number; blocked: number; uncertain: number;
  costUsd: number; latencyMs: number; modelCalls: number;
};
export type ReviewProposal = { proposalId: string; capability: string; rule: string; evidence: string; priority: 'high' | 'normal' };
export type Review = {
  version: 1; reviewId: string; profileId: string; weekStart: string; weekEnd: string; createdAt: string;
  outcomes: OutcomeSummary;
  capabilities: (OutcomeSummary & { capability: string; medianLatencyMs: number | null })[];
  signals: JournalMetrics;
  proposals: ReviewProposal[];
};
export type JournalDigest = {
  version: 1; profileId: string; day: string; signals: JournalMetrics; outcomes: OutcomeSummary;
  review: { weekStart: string | null; proposals: number } | null;
};

type Row = Record<string, unknown>;
const integer = (value: unknown) => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(value) || 0));
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** UTC midnight of the day containing `ms`. */
export function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
/** Monday 00:00 UTC of the week containing `ms` (ISO weeks). */
export function startOfUtcWeek(ms: number): number {
  const day = startOfUtcDay(ms);
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
}
const dayString = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function dayRange(day: string): { start: number; end: number } {
  if (!/^\d{4}-\d\d-\d\d$/.test(day)) throw new TypeError('Invalid day');
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start) || dayString(start) !== day) throw new TypeError('Invalid day');
  return { start, end: start + DAY };
}
function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * The durable journal: signals, deterministic decisions, open issues, outcomes and weekly reviews. It is a data
 * store only; the service maps a decision to a notification and never dispatches work from here.
 */
export class SignalStore {
  private readonly db: DatabaseSync;
  private readonly profileId: string;
  private readonly clock: () => number;
  constructor(path: string, profileId: string, clock: () => number = Date.now) {
    if (typeof profileId !== 'string' || !profileId.length) throw new TypeError('Invalid profile');
    this.profileId = profileId;
    this.clock = clock;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS signals (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, signal_id TEXT NOT NULL, profile TEXT NOT NULL,
          source TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL, observed_at TEXT NOT NULL,
          received_at INTEGER NOT NULL, dedupe_key TEXT NOT NULL, subject TEXT NOT NULL, summary TEXT NOT NULL,
          correlation_id TEXT, attention TEXT NOT NULL, evidence TEXT NOT NULL,
          UNIQUE(profile, signal_id), UNIQUE(profile, dedupe_key));
        CREATE TABLE IF NOT EXISTS decisions (
          sequence INTEGER PRIMARY KEY, profile TEXT NOT NULL, rule_id TEXT NOT NULL, action TEXT NOT NULL,
          reason TEXT NOT NULL, category TEXT, decided_at INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
          model_calls INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS issues (
          profile TEXT NOT NULL, subject TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
          opened_sequence INTEGER NOT NULL, opened_at INTEGER NOT NULL, closed_sequence INTEGER, closed_at INTEGER,
          PRIMARY KEY(profile, subject));
        CREATE TABLE IF NOT EXISTS outcomes (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, outcome_id TEXT NOT NULL, profile TEXT NOT NULL,
          capability TEXT NOT NULL, expectation TEXT NOT NULL, result TEXT NOT NULL, verification TEXT NOT NULL,
          evidence TEXT NOT NULL, cost_usd REAL NOT NULL, latency_ms INTEGER NOT NULL, model_calls INTEGER NOT NULL,
          task_id TEXT, signal_id TEXT, observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
          UNIQUE(profile, outcome_id));
        CREATE TABLE IF NOT EXISTS reviews (
          profile TEXT NOT NULL, week_start TEXT NOT NULL, created_at INTEGER NOT NULL, snapshot TEXT NOT NULL,
          PRIMARY KEY(profile, week_start));
        CREATE TABLE IF NOT EXISTS journal_counters (
          profile TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(profile, name));`);
    } catch (error) { this.db.close(); throw error; }
  }

  matchesProfile(profileId: string): boolean { return this.profileId === profileId; }
  close(): void { this.db.close(); }

  private signalRow(row: Row): StoredSignal {
    const signal = parseSignal({
      version: 1, signalId: row.signal_id, profileId: row.profile, source: row.source, kind: row.kind,
      severity: row.severity, observedAt: row.observed_at, dedupeKey: row.dedupe_key, subject: row.subject,
      summary: row.summary, correlationId: row.correlation_id, attention: row.attention,
      evidence: { kind: 'observed', reference: row.evidence },
    });
    return { ...signal, sequence: Number(row.sequence), receivedAt: Number(row.received_at) };
  }
  private decisionRow(row: Row): DecisionRecord {
    return {
      ruleId: String(row.rule_id), action: row.action as ReflexAction, reason: String(row.reason),
      category: row.category === null ? null : String(row.category), decidedAt: Number(row.decided_at),
      latencyMs: Number(row.latency_ms), modelCalls: Number(row.model_calls),
    };
  }
  private bump(name: string): void {
    this.db.prepare('INSERT INTO journal_counters VALUES (?, ?, 1) ON CONFLICT(profile, name) DO UPDATE SET value = value + 1').run(this.profileId, name);
  }
  private outcomeRow(row: Row): Outcome {
    return {
      version: 1, outcomeId: String(row.outcome_id), profileId: String(row.profile), capability: String(row.capability),
      expectation: String(row.expectation), result: String(row.result), verification: String(row.verification) as Outcome['verification'],
      evidence: String(row.evidence), costUsd: Number(row.cost_usd), latencyMs: Number(row.latency_ms), modelCalls: Number(row.model_calls),
      taskId: row.task_id === null ? null : String(row.task_id), signalId: row.signal_id === null ? null : String(row.signal_id),
      observedAt: String(row.observed_at), sequence: Number(row.sequence), recordedAt: String(row.recorded_at),
    };
  }

  /** Same profile + `dedupeKey` is a no-op: the stored signal and `duplicate: true` come back. */
  ingest(value: unknown): { signal: StoredSignal; duplicate: boolean } {
    const signal = parseSignal(value);
    if (signal.profileId !== this.profileId) throw new TypeError('Signal profile mismatch');
    return immediate(this.db, () => {
      const received = this.clock();
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO signals
        (signal_id, profile, source, kind, severity, observed_at, received_at, dedupe_key, subject, summary, correlation_id, attention, evidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(signal.signalId, this.profileId, signal.source, signal.kind, signal.severity, signal.observedAt, received, signal.dedupeKey, signal.subject, signal.summary, signal.correlationId, signal.attention, signal.evidence.reference);
      const duplicate = Number(inserted.changes) === 0;
      if (duplicate) this.bump('duplicates');
      const row = this.db.prepare('SELECT * FROM signals WHERE profile = ? AND dedupe_key = ?').get(this.profileId, signal.dedupeKey) as Row | undefined;
      if (!row) throw new TypeError('Signal id reused with a different dedupe key');
      return { signal: this.signalRow(row), duplicate };
    });
  }

  decision(sequence: number): DecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE profile = ? AND sequence = ?').get(this.profileId, sequence) as Row | undefined;
    return row ? this.decisionRow(row) : null;
  }
  openIssue(subject: string): { openedAt: number; kind: string } | null {
    const row = this.db.prepare('SELECT opened_at, kind FROM issues WHERE profile = ? AND subject = ? AND closed_sequence IS NULL').get(this.profileId, subject) as Row | undefined;
    return row ? { openedAt: Number(row.opened_at), kind: String(row.kind) } : null;
  }
  lastAttention(subject: string): number | null {
    const row = this.db.prepare(`SELECT MAX(d.decided_at) AS at FROM decisions d JOIN signals s ON s.sequence = d.sequence
      WHERE s.profile = ? AND s.subject = ? AND d.action = 'notify'`).get(this.profileId, subject) as Row | undefined;
    return row?.at === null || row?.at === undefined ? null : Number(row.at);
  }

  /**
   * Persists the deterministic decision and updates the subject's issue. One decision per signal; a replay returns
   * the first decision instead of re-notifying.
   */
  decide(signal: StoredSignal, rule: ReflexRule, now = this.clock()): DecisionRecord {
    const existing = this.decision(signal.sequence);
    if (existing) return existing;
    const latency = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, now - Date.parse(signal.observedAt)));
    return immediate(this.db, () => {
      this.db.prepare(`INSERT INTO decisions (sequence, profile, rule_id, action, reason, category, decided_at, latency_ms, model_calls)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(signal.sequence, this.profileId, rule.ruleId, rule.action, rule.reason, rule.category, now, latency);
      if (rule.action === 'notify') {
        this.db.prepare(`INSERT INTO issues (profile, subject, source, kind, opened_sequence, opened_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(profile, subject) DO UPDATE SET
            source = excluded.source, kind = excluded.kind, closed_sequence = NULL, closed_at = NULL,
            opened_sequence = CASE WHEN issues.closed_sequence IS NULL THEN issues.opened_sequence ELSE excluded.opened_sequence END,
            opened_at = CASE WHEN issues.closed_sequence IS NULL THEN issues.opened_at ELSE excluded.opened_at END`)
          .run(this.profileId, signal.subject, signal.source, signal.kind, signal.sequence, now);
      } else if (rule.action === 'resolve') {
        this.db.prepare('UPDATE issues SET closed_sequence = ?, closed_at = ? WHERE profile = ? AND subject = ? AND closed_sequence IS NULL')
          .run(signal.sequence, now, this.profileId, signal.subject);
      }
      return this.decisionRow({ rule_id: rule.ruleId, action: rule.action, reason: rule.reason, category: rule.category, decided_at: now, latency_ms: latency, model_calls: 0 });
    });
  }

  signals(after = 0, limit = 50): SignalPage {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid signal page');
    const rows = this.db.prepare(`SELECT s.*, d.rule_id, d.action, d.reason, d.category, d.decided_at, d.latency_ms, d.model_calls
      FROM signals s LEFT JOIN decisions d ON d.sequence = s.sequence
      WHERE s.profile = ? AND s.sequence > ? ORDER BY s.sequence LIMIT ?`).all(this.profileId, after, limit + 1) as Row[];
    const page = rows.slice(0, limit).map(row => ({ ...this.signalRow(row), decision: row.action === null ? null : this.decisionRow(row) }));
    return { signals: page, nextCursor: rows.length > limit ? page[page.length - 1].sequence : null };
  }

  metrics(from = 0, to = Number.MAX_SAFE_INTEGER): JournalMetrics {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new TypeError('Invalid metrics range');
    const signals = this.db.prepare('SELECT source, kind, attention FROM signals WHERE profile = ? AND received_at >= ? AND received_at < ?').all(this.profileId, from, to) as Row[];
    const bySource: Record<string, number> = {}, byKind: Record<string, number> = {};
    for (const row of signals) {
      bySource[String(row.source)] = (bySource[String(row.source)] ?? 0) + 1;
      byKind[String(row.kind)] = (byKind[String(row.kind)] ?? 0) + 1;
    }
    const decisions = this.db.prepare(`SELECT d.action, d.latency_ms, d.model_calls, s.attention FROM decisions d
      JOIN signals s ON s.sequence = d.sequence WHERE d.profile = ? AND d.decided_at >= ? AND d.decided_at < ?`).all(this.profileId, from, to) as Row[];
    let notify = 0, resolve = 0, ignore = 0, handled = 0, turns = 0, modelCalls = 0;
    const latencies: number[] = [];
    for (const row of decisions) {
      const action = String(row.action);
      if (action === 'notify') notify++;
      else if (action === 'resolve') resolve++;
      else ignore++;
      if (action !== 'ignore' && Number(row.model_calls) === 0) handled++;
      if (row.attention === 'wake' && Number(row.model_calls) === 0) turns++;
      modelCalls += integer(row.model_calls);
      latencies.push(integer(row.latency_ms));
    }
    latencies.sort((a, b) => a - b);
    const duplicates = this.db.prepare('SELECT value FROM journal_counters WHERE profile = ? AND name = ?').get(this.profileId, 'duplicates') as Row | undefined;
    return {
      from, to, total: signals.length, bySource, byKind, notify, resolve, ignore, handledWithoutModel: handled, turnsAvoided: turns,
      resolutionRate: notify + resolve ? round(resolve / (notify + resolve)) : null,
      p50DecisionMs: percentile(latencies, 0.5), p95DecisionMs: percentile(latencies, 0.95),
      modelCalls, duplicates: Number(duplicates?.value ?? 0),
    };
  }

  recordOutcome(value: unknown): Outcome {
    const input = parseOutcomeInput(value);
    if (input.profileId !== this.profileId) throw new TypeError('Outcome profile mismatch');
    const recordedAt = new Date(this.clock()).toISOString();
    return immediate(this.db, () => {
      const result = this.db.prepare(`INSERT OR IGNORE INTO outcomes
        (outcome_id, profile, capability, expectation, result, verification, evidence, cost_usd, latency_ms, model_calls, task_id, signal_id, observed_at, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.outcomeId, this.profileId, input.capability, input.expectation, input.result, input.verification, input.evidence, input.costUsd, input.latencyMs, input.modelCalls, input.taskId, input.signalId, input.observedAt, recordedAt);
      if (Number(result.changes) === 0) {
        const existing = this.db.prepare('SELECT * FROM outcomes WHERE profile = ? AND outcome_id = ?').get(this.profileId, input.outcomeId) as Row | undefined;
        if (!existing) throw new Error('outcome_not_stored');
        return this.outcomeRow(existing);
      }
      return { ...input, sequence: Number(result.lastInsertRowid), recordedAt };
    });
  }
  outcomes(after = 0, limit = 50): OutcomePage {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid outcome page');
    const rows = this.db.prepare('SELECT * FROM outcomes WHERE profile = ? AND sequence > ? ORDER BY sequence LIMIT ?').all(this.profileId, after, limit + 1) as Row[];
    const page = rows.slice(0, limit).map(row => this.outcomeRow(row));
    return { outcomes: page, nextCursor: rows.length > limit ? page[page.length - 1].sequence : null };
  }

  private summarize(rows: Outcome[]): OutcomeSummary {
    const summary: OutcomeSummary = { total: rows.length, verified: 0, notVerified: 0, blocked: 0, uncertain: 0, costUsd: 0, latencyMs: 0, modelCalls: 0 };
    for (const row of rows) {
      if (row.verification === 'verified') summary.verified++;
      else if (row.verification === 'blocked') summary.blocked++;
      else if (row.verification === 'uncertain') summary.uncertain++;
      else summary.notVerified++;
      summary.costUsd += row.costUsd;
      summary.latencyMs += row.latencyMs;
      summary.modelCalls += row.modelCalls;
    }
    summary.costUsd = round(summary.costUsd);
    return summary;
  }

  /**
   * Deterministic weekly review: aggregates outcomes and signals and proposes rules for capabilities that repeatedly
   * end without verification. Proposals are data for the operator; this store never edits instructions or policy.
   */
  review(now = this.clock()): Review {
    const start = startOfUtcWeek(now), end = start + 7 * DAY;
    const startIso = new Date(start).toISOString(), endIso = new Date(end).toISOString();
    const rows = (this.db.prepare('SELECT * FROM outcomes WHERE profile = ? AND observed_at >= ? AND observed_at < ? ORDER BY sequence').all(this.profileId, startIso, endIso) as Row[])
      .map(row => this.outcomeRow(row));
    const outcomes = this.summarize(rows);
    const grouped = new Map<string, Outcome[]>();
    for (const row of rows) grouped.set(row.capability, [...(grouped.get(row.capability) ?? []), row]);
    const capabilities = [...grouped.entries()].map(([capability, list]) => ({
      capability, ...this.summarize(list), medianLatencyMs: median(list.map(row => row.latencyMs)),
    })).sort((a, b) => b.total - a.total || a.capability.localeCompare(b.capability));
    const proposals: ReviewProposal[] = [];
    for (const cap of capabilities) {
      const bad = cap.notVerified + cap.blocked + cap.uncertain;
      if (bad < 2) continue;
      const proposalId = `proposal-${createHash('sha256').update(`${this.profileId}:${dayString(start)}:${cap.capability}`).digest('hex').slice(0, 16)}`;
      proposals.push({
        proposalId, capability: cap.capability,
        rule: `Para ${cap.capability}, anexar uma referencia observada antes de encerrar: ${bad} de ${cap.total} resultados desta semana ficaram sem verificacao.`,
        evidence: `outcomes:${cap.capability}:${dayString(start)}..${dayString(end)}`,
        priority: bad * 2 >= cap.total ? 'high' : 'normal',
      });
    }
    proposals.sort((a, b) => (a.priority === b.priority ? a.capability.localeCompare(b.capability) : a.priority === 'high' ? -1 : 1));
    const review: Review = {
      version: 1, reviewId: `review-${dayString(start)}`, profileId: this.profileId, weekStart: dayString(start),
      weekEnd: dayString(end), createdAt: new Date(now).toISOString(), outcomes, capabilities,
      signals: this.metrics(start, end), proposals,
    };
    this.db.prepare(`INSERT INTO reviews (profile, week_start, created_at, snapshot) VALUES (?, ?, ?, ?)
      ON CONFLICT(profile, week_start) DO UPDATE SET created_at = excluded.created_at, snapshot = excluded.snapshot`)
      .run(this.profileId, review.weekStart, now, JSON.stringify(review));
    return review;
  }
  latestReview(): Review | null {
    const row = this.db.prepare('SELECT snapshot FROM reviews WHERE profile = ? ORDER BY created_at DESC LIMIT 1').get(this.profileId) as Row | undefined;
    return row ? JSON.parse(String(row.snapshot)) as Review : null;
  }

  /** Aggregate day view for the nightly dream: counts and proposed rules, never signal text or outcome bodies. */
  digest(day = dayString(this.clock())): JournalDigest {
    const { start, end } = dayRange(day);
    const rows = (this.db.prepare('SELECT * FROM outcomes WHERE profile = ? AND observed_at >= ? AND observed_at < ?')
      .all(this.profileId, new Date(start).toISOString(), new Date(end).toISOString()) as Row[])
      .map(row => this.outcomeRow(row));
    const latest = this.latestReview();
    return {
      version: 1, profileId: this.profileId, day, signals: this.metrics(start, end), outcomes: this.summarize(rows),
      review: latest ? { weekStart: latest.weekStart, proposals: latest.proposals.length } : null,
    };
  }
}
