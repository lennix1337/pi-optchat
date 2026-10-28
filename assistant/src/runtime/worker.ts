import { DatabaseSync } from 'node:sqlite';
import type { Gateway, EffectMetadata, EffectRequest } from '../policy/gateway.ts';

/**
 * Durable worker decoupled from the TUI. Exactly one owner holds the lease; every
 * write it makes is fenced by the lease token, so an owner that lost the lease
 * cannot change state. External effects go only through the T02 gateway, which
 * persists intent before the sink runs: an ambiguous effect becomes
 * `effect_uncertain` and is never dispatched again by recovery.
 */
export type JobState = 'queued' | 'running' | 'dispatching' | 'done' | 'failed' | 'cancelled' | 'blocked' | 'effect_uncertain';
export type Job = { id: string; kind: string; parentId: string | null; state: JobState; attempts: number; result: unknown; error: string | null };
export type JobContext = { signal: AbortSignal; spawnChild(id: string, kind: string, input: unknown): void };
export type InternalHandler = (input: unknown, context: JobContext) => unknown | Promise<unknown>;
export type Reconciliation = 'done' | 'unknown';
export type EffectAdapter = {
  invoke(bytes: Uint8Array, metadata: Readonly<EffectMetadata>): unknown | Promise<unknown>;
  /** Observes the external system for an ambiguous effect; must never resend it. */
  reconcile?(metadata: Readonly<EffectMetadata>): Reconciliation | Promise<Reconciliation>;
};
export type EffectInput = Omit<EffectRequest, 'payload'> & { payloadBase64: string };
export type Notification = { id: string; channel: string; body: string; state: 'pending' | 'delivered' | 'failed'; attempts: number; error: string | null };
export type RuntimeOptions = {
  databasePath: string; owner: string; leaseMs?: number; now?: () => number;
  maxConcurrent?: number; maxQueued?: number; maxAttempts?: number;
  handlers?: Readonly<Record<string, InternalHandler>>;
  gateway?: Gateway; adapters?: Readonly<Record<string, EffectAdapter>>;
  /** Test seam: called after each durable boundary so a test process can die exactly there. */
  boundary?: (name: string, id: string) => void;
};
type Row = { id: string; kind: string; parent_id: string | null; input: string; state: JobState; attempts: number; cancel_requested: number; result: string | null; error: string | null };

const EFFECT = 'effect';
const MAX_RESULT = 64 * 1024;

function positive(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('invalid_options');
  return n;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('invalid_id');
  return value;
}
function encode(value: unknown): string {
  let text: string | undefined;
  try { text = JSON.stringify(value ?? null); } catch { return '{"unserializable":true}'; }
  if (text === undefined) return 'null';
  return text.length > MAX_RESULT ? '{"truncated":true}' : text;
}

const knownDispatchErrors = ['effect_uncertain', 'operation_already_dispatched', 'approval_required', 'denied', 'invalid_request', 'policy_error'];
/** A second dispatch of the same operation means an earlier attempt may have sent it: that is ambiguous, never failed. */
function classifyDispatchError(failure: unknown): { state: JobState; error: string } {
  const code = failure instanceof Error ? failure.message : '';
  const state: JobState = code === 'effect_uncertain' || code === 'operation_already_dispatched' ? 'effect_uncertain' : code === 'approval_required' ? 'blocked' : 'failed';
  return { state, error: knownDispatchErrors.includes(code) ? code : 'dispatch_error' };
}

export class WorkerRuntime {
  private db: DatabaseSync;
  private options: RuntimeOptions;
  private now: () => number;
  private leaseMs: number; private maxConcurrent: number; private maxQueued: number; private maxAttempts: number;
  private token = 0;
  private stopped = false;
  private active = new Map<string, AbortController>();
  private inflight = new Set<Promise<void>>();

  constructor(options: RuntimeOptions) {
    this.options = { ...options, handlers: { ...options.handlers }, adapters: { ...options.adapters } };
    identifier(options.owner);
    this.now = options.now ?? Date.now;
    this.leaseMs = positive(options.leaseMs, 30_000, 3_600_000);
    this.maxConcurrent = positive(options.maxConcurrent, 4, 64);
    this.maxQueued = positive(options.maxQueued, 1000, 100_000);
    this.maxAttempts = positive(options.maxAttempts, 3, 100);
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS lease (name TEXT PRIMARY KEY, owner TEXT NOT NULL, token INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, parent_id TEXT, input TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0, fence INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, channel TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, UNIQUE (id, channel));`);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Every owner write runs here: it commits only while this process still holds the lease token. */
  private fenced<T>(fn: () => T): T {
    return this.transaction(() => {
      const lease = this.db.prepare("SELECT owner, token FROM lease WHERE name = 'worker'").get() as { owner: string; token: number } | undefined;
      if (!this.token || !lease || lease.owner !== this.options.owner || lease.token !== this.token) throw new Error('lease_lost');
      return fn();
    });
  }
  private boundary(name: string, id: string): void { this.options.boundary?.(name, id); }
  private assertRunning(): void { if (this.stopped) throw new Error('worker_stopped'); }

  /** Takes the lease when free or expired, then recovers jobs a previous owner left in flight. */
  async acquire(): Promise<boolean> {
    this.assertRunning();
    const token = this.transaction(() => {
      const lease = this.db.prepare("SELECT owner, token, expires FROM lease WHERE name = 'worker'").get() as { owner: string; token: number; expires: number } | undefined;
      if (lease && lease.expires > this.now() && !(lease.owner === this.options.owner && lease.token === this.token)) return 0;
      const next = (lease?.token ?? 0) + 1;
      this.db.prepare("INSERT INTO lease VALUES ('worker', ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, token = excluded.token, expires = excluded.expires")
        .run(this.options.owner, next, this.now() + this.leaseMs);
      return next;
    });
    if (!token) return false;
    this.token = token;
    await this.recover();
    return true;
  }
  private renew(): void {
    this.fenced(() => { this.db.prepare("UPDATE lease SET expires = ? WHERE name = 'worker'").run(this.now() + this.leaseMs); });
  }

  private async recover(): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE state IN ('running', 'dispatching') ORDER BY seq").all() as Row[];
    for (const row of rows) {
      if (row.state === 'running') {
        // Internal jobs are idempotent; an effect job that never reached dispatch has no intent yet.
        const next: JobState = row.cancel_requested ? 'cancelled' : row.attempts >= this.maxAttempts ? 'failed' : 'queued';
        this.fenced(() => this.db.prepare("UPDATE jobs SET state = ?, error = ? WHERE id = ? AND state = 'running'").run(next, next === 'failed' ? 'attempts_exhausted' : null, row.id));
        continue;
      }
      await this.recoverDispatch(row);
    }
  }
  private async recoverDispatch(row: Row): Promise<void> {
    const gateway = this.options.gateway;
    const input = JSON.parse(row.input) as EffectInput;
    const status = gateway ? gateway.status(input.operationId) : 'uncertain';
    let next: JobState; let result: string | null = null; let error: string | null = null;
    if (status === 'absent') next = row.cancel_requested ? 'cancelled' : 'queued';
    else if (status === 'response_recorded') { next = 'done'; result = '{"recovered":true}'; }
    else {
      next = 'effect_uncertain'; error = 'effect_uncertain';
      const adapter = this.options.adapters?.[input.adapter];
      if (adapter?.reconcile) {
        const { payloadBase64: _payload, ...metadata } = input;
        try { if (await adapter.reconcile(Object.freeze({ ...metadata })) === 'done') { next = 'done'; result = '{"reconciled":true}'; error = null; } }
        catch { /* the effect stays uncertain and visible */ }
      }
    }
    this.fenced(() => this.db.prepare("UPDATE jobs SET state = ?, result = ?, error = ? WHERE id = ? AND state = 'dispatching'").run(next, result, error, row.id));
  }

  /** Same id with the same input is idempotent; different input is a conflict. Refuses when full (backpressure). */
  enqueue(id: string, kind: string, input: unknown, parentId: string | null = null): Job {
    this.assertRunning();
    identifier(id); identifier(kind);
    if (kind === EFFECT) this.effectRequest(input as EffectInput);
    else if (!this.options.handlers?.[kind]) throw new Error('unknown_kind');
    const text = encode(input);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
      if (existing) {
        if (existing.kind !== kind || existing.input !== text || existing.parent_id !== parentId) throw new Error('job_conflict');
        return this.toJob(existing);
      }
      const pending = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued', 'running', 'dispatching')").get() as { n: number };
      if (pending.n >= this.maxQueued) throw new Error('queue_full');
      this.db.prepare("INSERT INTO jobs (id, kind, parent_id, input, state) VALUES (?, ?, ?, ?, 'queued')").run(id, kind, parentId, text);
      return this.toJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row);
    });
  }
  private effectRequest(input: EffectInput): EffectRequest {
    if (!input || typeof input !== 'object' || typeof input.payloadBase64 !== 'string') throw new Error('invalid_request');
    const { payloadBase64, ...metadata } = input;
    return { ...metadata, payload: Buffer.from(payloadBase64, 'base64') };
  }

  /** Claims up to the free concurrency slots and runs them. Returns how many jobs it ran. */
  async runOnce(): Promise<number> {
    this.assertRunning();
    this.renew();
    const slots = this.maxConcurrent - this.inflight.size;
    if (slots <= 0) return 0;
    const claimed = this.fenced(() => {
      const rows = this.db.prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY seq LIMIT ?").all(slots) as Row[];
      for (const row of rows) this.db.prepare("UPDATE jobs SET state = 'running', attempts = attempts + 1, fence = ? WHERE id = ?").run(this.token, row.id);
      return rows.map(row => ({ ...row, attempts: row.attempts + 1 }));
    });
    for (const row of claimed) this.boundary('claimed', row.id);
    const runs = claimed.map(row => {
      const run = (row.kind === EFFECT ? this.runEffect(row) : this.runInternal(row)).finally(() => { this.inflight.delete(run); });
      this.inflight.add(run);
      return run;
    });
    await Promise.all(runs);
    return claimed.length;
  }

  private async runInternal(row: Row): Promise<void> {
    const controller = new AbortController();
    this.active.set(row.id, controller);
    const context: JobContext = {
      signal: controller.signal,
      spawnChild: (id, kind, input) => {
        if (this.stopped || controller.signal.aborted) throw new Error('worker_stopped');
        this.enqueue(id, kind, input, row.id);
      },
    };
    let outcome: { ok: true; value: unknown } | { ok: false };
    try { outcome = { ok: true, value: await this.options.handlers![row.kind](JSON.parse(row.input), context) }; }
    catch { outcome = { ok: false }; }
    finally { this.active.delete(row.id); }
    this.boundary('handled', row.id);
    this.fenced(() => {
      const current = this.db.prepare('SELECT state, cancel_requested FROM jobs WHERE id = ?').get(row.id) as { state: JobState; cancel_requested: number };
      if (current.state !== 'running') return;
      let state: JobState; let error: string | null = null;
      if (current.cancel_requested) state = 'cancelled';
      else if (outcome.ok) state = 'done';
      else if (this.stopped) state = 'queued';
      else if (row.attempts >= this.maxAttempts) { state = 'failed'; error = 'attempts_exhausted'; }
      else { state = 'queued'; error = 'handler_error'; }
      this.db.prepare('UPDATE jobs SET state = ?, result = ?, error = ? WHERE id = ?').run(state, state === 'done' && outcome.ok ? encode(outcome.value) : null, error, row.id);
    });
    this.boundary('recorded', row.id);
  }

  private async runEffect(row: Row): Promise<void> {
    const gateway = this.options.gateway;
    const input = JSON.parse(row.input) as EffectInput;
    const adapter = this.options.adapters?.[input.adapter];
    const admitted = this.fenced(() => {
      const current = this.db.prepare('SELECT cancel_requested FROM jobs WHERE id = ?').get(row.id) as { cancel_requested: number };
      const state: JobState = current.cancel_requested ? 'cancelled' : this.stopped ? 'queued' : !gateway || !adapter ? 'failed' : 'dispatching';
      this.db.prepare("UPDATE jobs SET state = ?, error = ? WHERE id = ? AND state = 'running'").run(state, state === 'failed' ? 'no_adapter' : null, row.id);
      return state === 'dispatching';
    });
    if (!admitted) return;
    this.boundary('before_dispatch', row.id);
    let state: JobState; let result: string | null = null; let error: string | null = null;
    try {
      const value = await gateway!.dispatch(this.effectRequest(input), async (bytes, metadata) => {
        const response = await adapter!.invoke(bytes, metadata);
        this.boundary('in_sink', row.id);
        return response;
      });
      state = 'done'; result = encode(value);
    } catch (failure) {
      ({ state, error } = classifyDispatchError(failure));
    }
    this.boundary('after_dispatch', row.id);
    this.fenced(() => this.db.prepare("UPDATE jobs SET state = ?, result = ?, error = ? WHERE id = ? AND state = 'dispatching'").run(state, result, error, row.id));
    this.boundary('recorded', row.id);
  }

  /** Queued jobs cancel at once; running ones on their next boundary. A dispatched effect cannot be recalled. */
  cancel(id: string): JobState {
    const state = this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: JobState } | undefined;
      if (!row) throw new Error('unknown_job');
      if (row.state === 'queued') { this.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(id); return 'cancelled' as const; }
      if (row.state === 'running' || row.state === 'dispatching') this.db.prepare('UPDATE jobs SET cancel_requested = 1 WHERE id = ?').run(id);
      return row.state;
    });
    this.active.get(id)?.abort();
    return state;
  }

  /** Stable notification id per channel; re-notifying the same id and body is a no-op. */
  notify(id: string, channels: readonly string[], body: string): void {
    identifier(id);
    if (!Array.isArray(channels) || !channels.length || typeof body !== 'string' || !body.isWellFormed() || body.length > MAX_RESULT) throw new Error('invalid_notification');
    this.transaction(() => {
      for (const channel of new Set(channels)) {
        identifier(channel);
        const existing = this.db.prepare('SELECT body FROM outbox WHERE id = ? AND channel = ?').get(id, channel) as { body: string } | undefined;
        if (existing && existing.body !== body) throw new Error('notification_conflict');
        if (!existing) this.db.prepare("INSERT INTO outbox (id, channel, body, state) VALUES (?, ?, ?, 'pending')").run(id, channel, body);
      }
    });
  }
  /** Delivers pending notifications of one channel at least once; the channel acknowledges by stable id. */
  async deliver(channel: string, send: (notification: { id: string; body: string }) => void | Promise<void>, limit = 50): Promise<{ delivered: number; failed: number }> {
    this.assertRunning();
    this.renew();
    const rows = this.db.prepare("SELECT id, body, attempts FROM outbox WHERE channel = ? AND state = 'pending' ORDER BY seq LIMIT ?").all(channel, limit) as { id: string; body: string; attempts: number }[];
    let delivered = 0; let failed = 0;
    for (const row of rows) {
      try { await send({ id: row.id, body: row.body }); }
      catch {
        failed++;
        this.fenced(() => this.db.prepare('UPDATE outbox SET attempts = attempts + 1, state = ?, error = ? WHERE id = ? AND channel = ?')
          .run(row.attempts + 1 >= this.maxAttempts ? 'failed' : 'pending', 'delivery_failed', row.id, channel));
        continue;
      }
      this.boundary('sent', row.id);
      this.fenced(() => this.db.prepare("UPDATE outbox SET attempts = attempts + 1, state = 'delivered', error = NULL WHERE id = ? AND channel = ?").run(row.id, channel));
      delivered++;
    }
    return { delivered, failed };
  }

  job(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row && this.toJob(row);
  }
  jobs(): Job[] { return (this.db.prepare('SELECT * FROM jobs ORDER BY seq').all() as Row[]).map(row => this.toJob(row)); }
  notifications(): Notification[] {
    return this.db.prepare('SELECT id, channel, body, state, attempts, error FROM outbox ORDER BY seq').all() as Notification[];
  }
  private toJob(row: Row): Job {
    return { id: row.id, kind: row.kind, parentId: row.parent_id, state: row.state, attempts: row.attempts, result: row.result === null ? null : JSON.parse(row.result), error: row.error };
  }

  /** Clean stop: refuse new work and children, abort handlers, let in-flight jobs record, then release the lease. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.inflight]);
    try { this.fenced(() => this.db.prepare("UPDATE lease SET expires = 0 WHERE name = 'worker'").run()); } catch { /* lease already taken over */ }
    this.token = 0;
  }
  close(): void { this.db.close(); }
}

export function createRuntime(options: RuntimeOptions): WorkerRuntime { return new WorkerRuntime(options); }
