import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { immediate } from '../store/transaction.ts';

/**
 * Transactional outbox for the service's outbound effects (Slack posts, updates, reactions, notices).
 *
 * `stage` runs inside the caller's transaction, so the effect row commits with the state change that caused it, or
 * not at all. A row then moves `pending` → `sending` (claimed and committed right before the transport call) →
 * `sent`, `failed` (a definite refusal, or retries used up) or `uncertain`. `sending` found at startup means the process
 * died inside the call: it becomes `uncertain` and is never resent by this module. Only a refusal the transport marks
 * retryable goes back to `pending`; any other transport failure is uncertain, because the effect may have happened.
 * The row id is the idempotency key the producer chose; providers without idempotency keys are reconciled, not replayed.
 */
export type OutboxState = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain';
export type OutboxRow = {
  id: string; channel: string; kind: string; payload: unknown; state: OutboxState; attempts: number;
  nextAttemptAt: number; reason: string | null; createdAt: number; updatedAt: number;
};
export type StageInput = { id: string; channel: string; kind: string; payload: unknown };
export type Settlement =
  | { kind: 'sent' }
  | { kind: 'failed'; code: string }
  | { kind: 'retry'; code: string }
  | { kind: 'uncertain'; reason: string };
export type OutboxOptions = {
  now?: () => number;
  /** Dispatches of a retryable refusal stop after this many attempts (the row is then `failed`). */
  maxAttempts?: number;
  /** Base delay before a retry; attempt n waits n × this. */
  retryDelayMs?: number;
  /** Test seam: called after each durable boundary, so a test can make the process "die" exactly there. */
  boundary?: (name: 'claimed' | 'transport_returned', id: string) => void;
};

/**
 * A transport's definite refusal: the effect did not happen. The message is a short code (never provider text);
 * `retryable` refusals (for example a rate limit) may be dispatched again.
 */
export class OutboxRefused extends Error {
  readonly retryable: boolean;
  constructor(code: string, retryable = false) { super(code); this.name = 'OutboxRefused'; this.retryable = retryable; }
}

export const OUTBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS outbox (
  profile TEXT NOT NULL, id TEXT NOT NULL, channel TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, reason TEXT,
  created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (profile, id));
  CREATE INDEX IF NOT EXISTS outbox_due ON outbox (profile, state, next_at);`;

type Row = { id: string; channel: string; kind: string; payload: string; state: OutboxState; attempts: number; next_at: number; reason: string | null; created: number; updated: number };

export class Outbox {
  private readonly db: DatabaseSync;
  private readonly profileId: string;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly boundary: OutboxOptions['boundary'];

  constructor(db: DatabaseSync, profileId: string, options: OutboxOptions = {}) {
    this.db = db; this.profileId = profileId;
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.boundary = options.boundary;
    this.db.exec(OUTBOX_SCHEMA);
  }

  /**
   * Records an effect as `pending`. Must run inside the caller's open transaction, so a rolled-back state change leaves
   * no row. The same id with the same channel, kind and payload is a no-op; the same id with other content is refused.
   */
  stage(input: StageInput): 'staged' | 'duplicate' {
    if (!this.db.isTransaction) throw new Error('outbox_requires_transaction');
    checkInput(input);
    const payload = JSON.stringify(input.payload);
    const existing = this.row(input.id);
    if (existing) {
      if (existing.channel !== input.channel || existing.kind !== input.kind || existing.payload !== payload) throw new Error('outbox_conflict');
      return 'duplicate';
    }
    const now = this.now();
    this.db.prepare("INSERT INTO outbox (profile, id, channel, kind, payload, state, attempts, next_at, reason, created, updated) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)")
      .run(this.profileId, input.id, input.channel, input.kind, payload, now, now, now);
    return 'staged';
  }

  get(id: string): OutboxRow | null {
    const row = this.row(id);
    return row ? this.view(row) : null;
  }

  /** Read-only: rows in one state, oldest first, for an operator or a report. */
  list(state: OutboxState, limit = 50): OutboxRow[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Invalid page limit');
    return (this.db.prepare('SELECT * FROM outbox WHERE profile = ? AND state = ? ORDER BY rowid LIMIT ?').all(this.profileId, state, limit) as unknown as Row[]).map(row => this.view(row));
  }

  /** The earliest time a pending row becomes due again, or null when nothing waits for a retry. */
  nextDueAt(): number | null {
    const row = this.db.prepare("SELECT MIN(next_at) AS at FROM outbox WHERE profile = ? AND state = 'pending'").get(this.profileId) as { at: number | null };
    return row.at === null ? null : Number(row.at);
  }

  /**
   * Startup only, before any dispatch: a row left `sending` means the process died inside its call. It becomes
   * `uncertain` (reconciled by an operator or an observer), never `pending` again.
   */
  recover(): number {
    return immediate(this.db, () => {
      const result = this.db.prepare("UPDATE outbox SET state = 'uncertain', reason = 'interrupted', updated = ? WHERE profile = ? AND state = 'sending'").run(this.now(), this.profileId);
      return Number(result.changes);
    });
  }

  /**
   * Delivers due pending rows in order through `transport`, which receives the row (its id is the idempotency key).
   * Each row is claimed and committed before the call and settled after it.
   */
  async dispatch(transport: (row: OutboxRow) => Promise<void>, limit = 20): Promise<{ sent: number; failed: number; retrying: number; uncertain: number }> {
    const summary = { sent: 0, failed: 0, retrying: 0, uncertain: 0 };
    const due = this.db.prepare("SELECT * FROM outbox WHERE profile = ? AND state = 'pending' AND next_at <= ? ORDER BY rowid LIMIT ?")
      .all(this.profileId, this.now(), limit) as unknown as Row[];
    for (const row of due) {
      if (!this.claim(row.id)) continue;
      this.boundary?.('claimed', row.id);
      const view = this.view({ ...row, state: 'sending', attempts: row.attempts + 1 });
      let settlement: Settlement;
      try { await transport(view); settlement = { kind: 'sent' }; }
      catch (error) { settlement = refusalOrUncertain(error, true); }
      this.boundary?.('transport_returned', row.id);
      const state = this.settle(row.id, settlement);
      summary[state === 'sent' ? 'sent' : state === 'failed' ? 'failed' : state === 'pending' ? 'retrying' : 'uncertain']++;
    }
    return summary;
  }

  /**
   * A synchronous write whose caller waits for the answer (an HTTP request). Its intent commits as `sending` before
   * `run` starts; the outcome is settled after it. A refusal is terminal here: the caller decides about any retry.
   */
  async perform<T>(channel: string, kind: string, payload: unknown, run: () => Promise<T>): Promise<T> {
    const id = `${kind}:${randomUUID()}`;
    immediate(this.db, () => {
      this.stage({ id, channel, kind, payload });
      this.claimLocked(id);
    });
    let result: T;
    try { result = await run(); }
    catch (error) { this.settle(id, refusalOrUncertain(error, false)); throw error; }
    this.settle(id, { kind: 'sent' });
    return result;
  }

  /** An operator's decision on an uncertain row: `sent` ends it, `not_sent` (checked at the provider) makes it pending again. */
  reconcile(id: string, decision: 'sent' | 'not_sent'): void {
    immediate(this.db, () => {
      const row = this.row(id);
      if (row?.state !== 'uncertain') throw new Error('outbox_not_uncertain');
      const now = this.now();
      if (decision === 'sent') this.db.prepare("UPDATE outbox SET state = 'sent', reason = 'reconciled_sent', updated = ? WHERE profile = ? AND id = ?").run(now, this.profileId, id);
      else this.db.prepare("UPDATE outbox SET state = 'pending', reason = 'reconciled_not_sent', next_at = ?, updated = ? WHERE profile = ? AND id = ?").run(now, now, this.profileId, id);
    });
  }

  private claim(id: string): boolean {
    return immediate(this.db, () => this.claimLocked(id));
  }
  private claimLocked(id: string): boolean {
    const now = this.now();
    const result = this.db.prepare("UPDATE outbox SET state = 'sending', attempts = attempts + 1, updated = ? WHERE profile = ? AND id = ? AND (state = 'pending' AND next_at <= ?)")
      .run(now, this.profileId, id, now);
    return result.changes === 1;
  }

  /** Commits the outcome of a claimed row and returns its new state. */
  private settle(id: string, outcome: Settlement): OutboxState {
    return immediate(this.db, () => {
      const row = this.row(id);
      if (row?.state !== 'sending') throw new Error('outbox_not_claimed');
      const now = this.now();
      if (outcome.kind === 'sent') return this.write(id, 'sent', null, now);
      if (outcome.kind === 'uncertain') return this.write(id, 'uncertain', outcome.reason, now);
      if (outcome.kind === 'failed') return this.write(id, 'failed', outcome.code, now);
      if (row.attempts >= this.maxAttempts) return this.write(id, 'failed', `${outcome.code}:attempts_exhausted`, now);
      this.db.prepare("UPDATE outbox SET state = 'pending', reason = ?, next_at = ?, updated = ? WHERE profile = ? AND id = ?")
        .run(outcome.code, now + this.retryDelayMs * row.attempts, now, this.profileId, id);
      return 'pending';
    });
  }

  private write(id: string, state: OutboxState, reason: string | null, now: number): OutboxState {
    this.db.prepare('UPDATE outbox SET state = ?, reason = ?, updated = ? WHERE profile = ? AND id = ?').run(state, reason, now, this.profileId, id);
    return state;
  }

  private row(id: string): Row | null {
    if (typeof id !== 'string' || !id.length) throw new TypeError('Invalid outbox id');
    return (this.db.prepare('SELECT * FROM outbox WHERE profile = ? AND id = ?').get(this.profileId, id) as unknown as Row | undefined) ?? null;
  }

  private view(row: Row): OutboxRow {
    return {
      id: String(row.id), channel: String(row.channel), kind: String(row.kind), payload: JSON.parse(String(row.payload)) as unknown,
      state: row.state, attempts: Number(row.attempts), nextAttemptAt: Number(row.next_at), reason: row.reason === null ? null : String(row.reason),
      createdAt: Number(row.created), updatedAt: Number(row.updated),
    };
  }
}

function checkInput(input: StageInput): void {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid outbox entry');
  if (typeof input.id !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(input.id)) throw new TypeError('Invalid outbox id');
  if (typeof input.channel !== 'string' || !input.channel.length || typeof input.kind !== 'string' || !input.kind.length) throw new TypeError('Invalid outbox entry');
  if (JSON.stringify(input.payload) === undefined) throw new TypeError('Invalid outbox payload');
}

/**
 * A definite refusal is retried only by the dispatcher (a synchronous caller owns its own retry); anything else may
 * have reached the provider, so it stays uncertain.
 */
function refusalOrUncertain(error: unknown, byDispatcher: boolean): Settlement {
  if (error instanceof OutboxRefused) {
    if (error.retryable && byDispatcher) return { kind: 'retry', code: error.message };
    return { kind: 'failed', code: error.message };
  }
  return { kind: 'uncertain', reason: 'transport_error' };
}
