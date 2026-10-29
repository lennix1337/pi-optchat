import { DatabaseSync } from 'node:sqlite';
import type { WorkerRuntime, Job } from '../runtime/worker.ts';
import { boundedInteger as bounded } from '../limits.ts';
import { immediate } from '../store/transaction.ts';
import { dueOccurrences, nextOccurrence, validateSchedule, type Schedule } from './schedule.ts';

/**
 * Routines enqueue jobs on the T03 worker; they never run work or effects
 * themselves. A routine is bound to a profile, a handler kind, its capabilities
 * and an authorization reference; effects still need gateway grants.
 *
 * Missed-time policy: when the clock passes several occurrences (sleep, restart,
 * clock jump), `once` (default) runs a single consolidated job for the newest
 * slot and reports how many were missed; `skip` runs it only within `graceMs`.
 * Ticks never replay every missed slot. A clock that moves backwards fires
 * nothing, and every job id is derived from its slot, so the same occurrence
 * is enqueued at most once no matter how many schedulers tick.
 */
export type MissedPolicy = 'once' | 'skip';
export type RoutineState = 'active' | 'paused' | 'deleted';
export type RoutineSpec = {
  id: string; profileId: string; kind: string; input?: unknown; schedule: Schedule;
  capabilities?: readonly string[]; authorization?: string | null;
  missed?: MissedPolicy; graceMs?: number; maxFailures?: number; source?: string;
};
export type Routine = {
  id: string; profileId: string; kind: string; input: unknown; schedule: Schedule; capabilities: string[]; authorization: string | null;
  missed: MissedPolicy; graceMs: number; maxFailures: number; source: string;
  state: RoutineState; pausedReason: string | null; activatedBy: string | null; nextRunAt: number | null; failures: number;
};
export type RunStatus = 'claimed' | 'enqueued' | 'done' | 'failed' | 'skipped_overlap' | 'skipped_missed' | 'queue_full' | 'clock_skew';
export type RunRecord = { routineId: string; slot: string; at: number; status: RunStatus; jobId: string | null; missed: number; detail: string | null };
export type RoutineOptions = {
  databasePath: string; runtime: WorkerRuntime; now?: () => number;
  /** Test seam: called after each durable boundary so a test process can die exactly there. */
  boundary?: (name: string, id: string) => void;
};

type Row = {
  id: string; profile_id: string; kind: string; input: string; schedule: string; capabilities: string; authorization: string | null;
  missed: MissedPolicy; grace_ms: number; max_failures: number; source: string; state: RoutineState; paused_reason: string | null;
  activated_by: string | null; next_run: number | null; failures: number; last_tick: number; current_job: string | null;
};
type RunRow = { routine_id: string; slot: string; at: number; status: RunStatus; job_id: string | null; missed: number; detail: string | null; input: string | null };

const MAX_INPUT = 16 * 1024;
const terminalFailure = new Set(['failed', 'blocked', 'cancelled', 'effect_uncertain']);

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 120 || !/^[A-Za-z0-9._:-]+$/u.test(value)) throw new Error('invalid_id');
  return value;
}
function capabilitiesOf(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error('invalid_capabilities');
  return [...new Set(value.map(identifier))].sort();
}
function encode(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  if (text === undefined || text.length > MAX_INPUT) throw new Error('invalid_input');
  return text;
}

export class RoutineManager {
  private db: DatabaseSync;
  private runtime: WorkerRuntime;
  private now: () => number;
  private boundary: (name: string, id: string) => void;

  constructor(options: RoutineOptions) {
    this.runtime = options.runtime;
    this.boundary = options.boundary ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, kind TEXT NOT NULL, input TEXT NOT NULL, schedule TEXT NOT NULL,
        capabilities TEXT NOT NULL, authorization TEXT, missed TEXT NOT NULL, grace_ms INTEGER NOT NULL, max_failures INTEGER NOT NULL, source TEXT NOT NULL,
        state TEXT NOT NULL, paused_reason TEXT, activated_by TEXT, next_run INTEGER, failures INTEGER NOT NULL DEFAULT 0,
        last_tick INTEGER NOT NULL DEFAULT 0, current_job TEXT);
      CREATE TABLE IF NOT EXISTS routine_runs (routine_id TEXT NOT NULL, slot TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL,
        job_id TEXT, missed INTEGER NOT NULL DEFAULT 0, detail TEXT, input TEXT, PRIMARY KEY (routine_id, slot));`);
  }

  private transaction<T>(fn: () => T): T { return immediate(this.db, fn); }
  private row(id: string): Row {
    const row = this.db.prepare("SELECT * FROM routines WHERE id = ? AND state != 'deleted'").get(id) as Row | undefined;
    if (!row) throw new Error('unknown_routine');
    return row;
  }

  /** New routines start paused until an operator activates them; creation alone never schedules work. */
  create(spec: RoutineSpec): Routine {
    const id = identifier(spec.id);
    const schedule = validateSchedule(spec.schedule);
    const missed = spec.missed ?? 'once';
    if (missed !== 'once' && missed !== 'skip') throw new Error('invalid_options');
    const values = [id, identifier(spec.profileId), identifier(spec.kind), encode(spec.input), JSON.stringify(schedule), JSON.stringify(capabilitiesOf(spec.capabilities)),
      spec.authorization == null ? null : identifier(spec.authorization), missed, bounded(spec.graceMs, 15 * 60_000, 0, 86_400_000),
      bounded(spec.maxFailures, 3, 1, 100), spec.source === undefined ? 'assistant' : identifier(spec.source)];
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM routines WHERE id = ?').get(id)) throw new Error('routine_exists');
      this.db.prepare(`INSERT INTO routines (id, profile_id, kind, input, schedule, capabilities, authorization, missed, grace_ms, max_failures, source, state, paused_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paused', 'not_activated')`).run(...values);
    });
    return this.get(id);
  }

  /**
   * Adopts an existing wake or dream as a paused routine with no capabilities and
   * no authorization: its old permissions are not transferred, and it does not
   * run until an operator re-grants and activates it. Adopting twice is a no-op.
   */
  adopt(spec: Pick<RoutineSpec, 'id' | 'profileId' | 'kind' | 'schedule' | 'source'>): Routine {
    const existing = this.db.prepare('SELECT id FROM routines WHERE id = ?').get(identifier(spec.id));
    if (existing) return this.get(spec.id);
    return this.create({ id: spec.id, profileId: spec.profileId, kind: spec.kind, schedule: spec.schedule, source: spec.source ?? 'legacy', capabilities: [], authorization: null });
  }

  /** Activation needs a named operator; it schedules from now, so time spent paused is not "missed". */
  resume(id: string, activatedBy: string): Routine {
    identifier(activatedBy);
    this.transaction(() => {
      const row = this.row(id);
      if (row.state === 'active') return;
      const next = nextOccurrence(JSON.parse(row.schedule) as Schedule, this.now());
      this.db.prepare("UPDATE routines SET state = 'active', paused_reason = NULL, activated_by = ?, next_run = ?, failures = 0 WHERE id = ?").run(activatedBy, next.at, id);
    });
    return this.get(id);
  }
  pause(id: string, reason = 'operator'): Routine {
    this.park(id, 'paused', identifier(reason));
    return this.get(id);
  }
  /** Stops scheduling: nothing runs until an operator resumes it (or ever, once deleted). */
  private park(id: string, state: 'paused' | 'deleted', reason: string): void {
    this.transaction(() => { this.row(id); this.db.prepare('UPDATE routines SET state = ?, paused_reason = ?, next_run = NULL WHERE id = ?').run(state, reason, id); });
  }
  /** Changing what a routine may do (kind, capabilities, authorization, profile) pauses it for re-activation. */
  edit(id: string, patch: Partial<Omit<RoutineSpec, 'id' | 'source'>>): Routine {
    this.transaction(() => {
      const row = this.row(id);
      const schedule = patch.schedule === undefined ? JSON.parse(row.schedule) as Schedule : validateSchedule(patch.schedule);
      const capabilities = patch.capabilities === undefined ? row.capabilities : JSON.stringify(capabilitiesOf(patch.capabilities));
      const authorization = patch.authorization === undefined ? row.authorization : patch.authorization === null ? null : identifier(patch.authorization);
      const kind = patch.kind === undefined ? row.kind : identifier(patch.kind);
      const profile = patch.profileId === undefined ? row.profile_id : identifier(patch.profileId);
      const missed = patch.missed ?? row.missed;
      if (missed !== 'once' && missed !== 'skip') throw new Error('invalid_options');
      const broadened = capabilities !== row.capabilities || authorization !== row.authorization || kind !== row.kind || profile !== row.profile_id;
      const state = broadened && row.state === 'active' ? 'paused' : row.state;
      const reason = state === 'paused' && row.state === 'active' ? 'needs_reactivation' : row.paused_reason;
      const next = state === 'active' ? nextOccurrence(schedule, this.now()).at : null;
      this.db.prepare(`UPDATE routines SET profile_id = ?, kind = ?, input = ?, schedule = ?, capabilities = ?, authorization = ?, missed = ?, grace_ms = ?, max_failures = ?,
        state = ?, paused_reason = ?, next_run = ? WHERE id = ?`).run(profile, kind, patch.input === undefined ? row.input : encode(patch.input), JSON.stringify(schedule),
        capabilities, authorization, missed, bounded(patch.graceMs, row.grace_ms, 0, 86_400_000), bounded(patch.maxFailures, row.max_failures, 1, 100), state, reason, next, id);
    });
    return this.get(id);
  }
  /** Deletes the routine; its run history stays for audit. A job already queued is left to the worker (cancel it there). */
  delete(id: string): void { this.park(id, 'deleted', 'deleted'); }

  get(id: string): Routine { return this.toRoutine(this.row(id)); }
  list(profileId?: string): Routine[] {
    const rows = this.db.prepare("SELECT * FROM routines WHERE state != 'deleted' ORDER BY id").all() as Row[];
    return rows.filter(row => profileId === undefined || row.profile_id === profileId).map(row => this.toRoutine(row));
  }
  /** Newest record first, in record order: `at` comes from the clock, which may have been wrong. */
  history(id: string, limit = 50): RunRecord[] {
    const rows = this.db.prepare('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY rowid DESC LIMIT ?').all(id, bounded(limit, 50, 1, 1000)) as RunRow[];
    return rows.map(row => ({ routineId: row.routine_id, slot: row.slot, at: row.at, status: row.status, jobId: row.job_id, missed: row.missed, detail: row.detail }));
  }

  /**
   * One scheduling pass: settle finished runs, then claim due slots. The claim
   * commits before the worker enqueue (separate connection); an interrupted
   * claim is re-enqueued with the same id and input on the next tick.
   */
  tick(): { claimed: string[]; enqueued: string[] } {
    const now = this.now();
    this.settle();
    const claimed: string[] = [];
    for (const row of this.db.prepare("SELECT id FROM routines WHERE state = 'active' AND next_run IS NOT NULL ORDER BY id").all() as { id: string }[]) {
      const jobId = this.claim(row.id, now);
      if (jobId) { claimed.push(jobId); this.boundary('claimed', jobId); }
    }
    const enqueued: string[] = [];
    for (const run of this.db.prepare("SELECT * FROM routine_runs WHERE status = 'claimed' ORDER BY at").all() as RunRow[]) {
      if (!this.enqueue(run)) continue;
      enqueued.push(run.job_id!);
      this.boundary('enqueued', run.job_id!);
    }
    return { claimed, enqueued };
  }

  private claim(id: string, now: number): string | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM routines WHERE id = ? AND state = 'active'").get(id) as Row | undefined;
      if (!row || row.next_run === null) return null;
      if (now < row.last_tick) {
        // Clock went backwards: fire nothing, keep the schedule, report it once per anchor slot.
        this.record({ routineId: row.id, slot: `skew@${row.last_tick}`, at: now, status: 'clock_skew', detail: `rewound ${row.last_tick - now}ms` });
        return null;
      }
      this.db.prepare('UPDATE routines SET last_tick = ? WHERE id = ?').run(now, id);
      if (row.next_run > now) return null;
      const schedule = JSON.parse(row.schedule) as Schedule;
      const due = dueOccurrences(schedule, row.next_run - 1, now);
      const latest = due.latest!;
      const missed = due.count - 1;
      // Every outcome below consumes the due slots: the schedule always moves past now.
      this.db.prepare('UPDATE routines SET next_run = ? WHERE id = ?').run(nextOccurrence(schedule, now).at, id);
      const base = { routineId: row.id, slot: latest.slot, at: now, detail: due.capped ? 'count_is_floor' : null };
      if (row.missed === 'skip' && now - latest.at > row.grace_ms) {
        this.record({ ...base, status: 'skipped_missed', missed: due.count });
        return null;
      }
      if (row.current_job && !this.finished(row.current_job)) {
        this.record({ ...base, status: 'skipped_overlap', missed, detail: row.current_job });
        return null;
      }
      const jobId = `routine:${row.id}:${latest.slot}`;
      const input = encode({ routineId: row.id, profileId: row.profile_id, slot: latest.slot, scheduledAt: latest.at, missed, capabilities: JSON.parse(row.capabilities),
        authorization: row.authorization, input: JSON.parse(row.input) });
      // A slot key already recorded (e.g. a time-zone edit mapped to a local slot that ran) never runs twice.
      if (!this.record({ ...base, status: 'claimed', jobId, missed, input })) return null;
      this.db.prepare('UPDATE routines SET current_job = ? WHERE id = ?').run(jobId, id);
      return jobId;
    });
  }
  /** Inserts a run record once per (routine, slot); returns false when the slot was already recorded. */
  private record(run: { routineId: string; slot: string; at: number; status: RunStatus; jobId?: string; missed?: number; detail?: string | null; input?: string }): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO routine_runs (routine_id, slot, at, status, job_id, missed, detail, input) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.routineId, run.slot, run.at, run.status, run.jobId ?? null, run.missed ?? 0, run.detail ?? null, run.input ?? null);
    return result.changes === 1;
  }
  private enqueue(run: RunRow): boolean {
    const routine = this.db.prepare('SELECT kind FROM routines WHERE id = ?').get(run.routine_id) as { kind: string };
    try { this.runtime.enqueue(run.job_id!, routine.kind, JSON.parse(run.input!)); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      // A full queue keeps the claim: the next tick retries the same job id.
      if (code === 'queue_full') { this.setStatus(run, 'claimed', 'queue_full'); return false; }
      this.setStatus(run, 'failed', code === 'unknown_kind' || code === 'job_conflict' || code === 'invalid_id' ? code : 'enqueue_error');
      this.fail(run.routine_id);
      return false;
    }
    this.setStatus(run, 'enqueued', null);
    return true;
  }
  private setStatus(run: RunRow, status: RunStatus, detail: string | null): void {
    this.transaction(() => this.db.prepare('UPDATE routine_runs SET status = ?, detail = ? WHERE routine_id = ? AND slot = ?').run(status, detail, run.routine_id, run.slot));
  }
  private finished(jobId: string): boolean {
    const job = this.runtime.job(jobId);
    return !job || !['queued', 'running', 'dispatching'].includes(job.state);
  }

  /** Records outcomes of finished jobs; consecutive failures or an uncertain effect suspend the routine. */
  private settle(): void {
    for (const run of this.db.prepare("SELECT * FROM routine_runs WHERE status = 'enqueued'").all() as RunRow[]) {
      const job: Job | undefined = this.runtime.job(run.job_id!);
      if (!job || ['queued', 'running', 'dispatching'].includes(job.state)) continue;
      if (job.state === 'done') {
        this.transaction(() => {
          this.db.prepare("UPDATE routine_runs SET status = 'done', detail = NULL WHERE routine_id = ? AND slot = ?").run(run.routine_id, run.slot);
          this.db.prepare('UPDATE routines SET failures = 0 WHERE id = ?').run(run.routine_id);
        });
      } else if (terminalFailure.has(job.state)) {
        this.setStatus(run, 'failed', job.error ?? job.state);
        if (job.state === 'effect_uncertain') this.pause(run.routine_id, 'effect_uncertain');
        else this.fail(run.routine_id);
      }
    }
  }
  private fail(id: string): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT failures, max_failures, state FROM routines WHERE id = ?').get(id) as { failures: number; max_failures: number; state: RoutineState };
      const failures = row.failures + 1;
      const suspend = row.state === 'active' && failures >= row.max_failures;
      this.db.prepare(`UPDATE routines SET failures = ?${suspend ? ", state = 'paused', paused_reason = 'consecutive_failures', next_run = NULL" : ''} WHERE id = ?`).run(failures, id);
    });
  }

  private toRoutine(row: Row): Routine {
    return {
      id: row.id, profileId: row.profile_id, kind: row.kind, input: JSON.parse(row.input), schedule: JSON.parse(row.schedule), capabilities: JSON.parse(row.capabilities),
      authorization: row.authorization, missed: row.missed, graceMs: row.grace_ms, maxFailures: row.max_failures, source: row.source, state: row.state,
      pausedReason: row.paused_reason, activatedBy: row.activated_by, nextRunAt: row.next_run, failures: row.failures,
    };
  }
  close(): void { this.db.close(); }
}

export function createRoutines(options: RoutineOptions): RoutineManager { return new RoutineManager(options); }
