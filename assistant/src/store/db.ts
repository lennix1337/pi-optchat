/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { immediate } from './transaction.ts';
import { parseEvent, type Event } from '../contracts/events.ts';
import { assertTaskTransition, parseTask, parseTaskResponse, type Task, type TaskResponse, type TaskStatus } from '../contracts/tasks.ts';

export type StoredEvent = { event: Event; operation: 'create' | 'transition' | 'respond'; task: Task };
export type TaskPage = { tasks: Task[]; nextCursor: string | null };
export type RestoreHold = { taskId: string; revision: number; title: string; status: 'queued' | 'working' };
/**
 * Task revisions that were queued or working in a restored backup. The original may have generated or dispatched them
 * after the snapshot, so no worker starts new work for a held revision until the operator reconciles it.
 */
export const RESTORE_HOLDS_TABLE = 'CREATE TABLE IF NOT EXISTS restore_holds (profile TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(profile,task_id))';
/** Restore runs this on the snapshot's task database: every task revision that was queued or working is held. */
export const RESTORE_HOLDS_FENCE = "INSERT OR REPLACE INTO restore_holds (profile, task_id, revision) SELECT profile, id, json_extract(snapshot, '$.revision') FROM tasks WHERE json_extract(snapshot, '$.status') IN ('queued', 'working')";

export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly profileId: string;
  constructor(path: string, profileId: string) {
    if (typeof profileId !== 'string' || !profileId.length) throw new TypeError('Invalid profile');
    this.profileId = profileId;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
        if (version > 1) throw new Error('Unsupported database version');
        if (version === 0) {
          if (this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error('Unknown database schema');
          this.db.exec(`CREATE TABLE tasks (profile TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(profile,id));
            CREATE TABLE events (profile TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, source_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile,sequence), UNIQUE(profile,event_id), UNIQUE(profile,source_id));
            CREATE TABLE responses (profile TEXT NOT NULL, task_id TEXT NOT NULL, input_revision INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(profile,task_id,input_revision));
            PRAGMA user_version = 1`);
        }
        this.db.exec('CREATE TABLE IF NOT EXISTS task_store_identity (id TEXT PRIMARY KEY)');
        if (!this.db.prepare('SELECT id FROM task_store_identity LIMIT 1').get()) this.db.prepare('INSERT INTO task_store_identity VALUES (?)').run(randomUUID());
        this.db.exec(RESTORE_HOLDS_TABLE);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }
  matchesProfile(profileId: string): boolean { return this.profileId === profileId; }
  /** Compare the open SQLite file, not its contents: copied databases are distinct. */
  matchesDatabase(path: string): boolean {
    const row = this.db.prepare('PRAGMA database_list').all().find(entry => entry.name === 'main');
    if (!row || typeof row.file !== 'string' || !row.file || !path || path === ':memory:') return false;
    try {
      const a = realpathSync(row.file), b = realpathSync(path);
      const x = statSync(a), y = statSync(b);
      if (a !== b || x.dev !== y.dev || x.ino !== y.ino) return false;
      const other = new DatabaseSync(b, { readOnly: true });
      try {
        const own = this.db.prepare('SELECT id FROM task_store_identity LIMIT 1').get();
        const candidate = other.prepare('SELECT id FROM task_store_identity LIMIT 1').get();
        return typeof own?.id === 'string' && own.id === candidate?.id;
      } finally { other.close(); }
    } catch { return false; }
  }
  nextSequence(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE profile = ?').get(this.profileId)!;
    return Number(row.sequence) + 1;
  }
  private transaction<T>(fn: () => T): T { return immediate(this.db, fn); }
  private append(eventInput: Event, task: Task, operation: StoredEvent['operation']): void {
    const event = parseEvent(eventInput);
    if (event.profileId !== this.profileId || event.taskId !== task.taskId) throw new TypeError('Event identity mismatch');
    if (event.sequence !== this.nextSequence()) throw new TypeError('Invalid event sequence');
    const payload: StoredEvent = { event, operation, task };
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(this.profileId, event.sequence, event.eventId, event.source.sourceEventId, JSON.stringify(payload));
  }
  create(taskInput: Task, event: Event): Task {
    return this.transaction(() => {
      const task = parseTask(taskInput);
      if (task.profileId !== this.profileId || !['suggested', 'queued'].includes(task.status) || task.revision !== 1 || task.inputRevision !== 1 || task.verification !== 'not_verified' || task.sourceEventId !== parseEvent(event).source.sourceEventId) throw new TypeError('Invalid initial task');
      this.append(event, task, 'create');
      this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(this.profileId, task.taskId, JSON.stringify(task));
      return structuredClone(task);
    });
  }
  /** One row of this profile's task; `sql` binds profile, task ID, then `params`. */
  private taskRow(sql: string, taskId: string, ...params: number[]) {
    if (typeof taskId !== 'string' || !taskId.length) throw new TypeError('Invalid task ID');
    return this.db.prepare(sql).get(this.profileId, taskId, ...params);
  }
  get(taskId: string): Task | null {
    const row = this.taskRow('SELECT snapshot FROM tasks WHERE profile = ? AND id = ?', taskId);
    return row ? parseTask(JSON.parse(String(row.snapshot))) : null;
  }
  list(cursor: string | null = null, limit = 50): TaskPage {
    this.checkLimit(limit);
    if (cursor !== null && (typeof cursor !== 'string' || !cursor.length)) throw new TypeError('Invalid task cursor');
    const rows = this.db.prepare('SELECT snapshot FROM tasks WHERE profile = ? AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?').all(this.profileId, cursor, cursor, limit + 1);
    const tasks = rows.slice(0, limit).map(row => parseTask(JSON.parse(String(row.snapshot))));
    return { tasks, nextCursor: rows.length > limit ? tasks[tasks.length - 1].taskId : null };
  }
  events(afterSequence = 0, limit = 50): StoredEvent[] {
    this.checkLimit(limit);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TypeError('Invalid event cursor');
    return this.db.prepare('SELECT payload FROM events WHERE profile = ? AND sequence > ? ORDER BY sequence LIMIT ?').all(this.profileId, afterSequence, limit).map(row => JSON.parse(String(row.payload)) as StoredEvent);
  }
  private checkLimit(limit: number): void { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid page limit'); }
  private update(task: Task, event: Event, operation: StoredEvent['operation']): Task {
    this.append(event, task, operation);
    this.db.prepare('UPDATE tasks SET snapshot = ? WHERE profile = ? AND id = ?').run(JSON.stringify(task), this.profileId, task.taskId);
    return structuredClone(task);
  }
  transition(taskId: string, expectedRevision: number, nextStatus: TaskStatus, event: Event): Task {
    return this.transaction(() => {
      const current = this.get(taskId);
      assertTaskTransition(current, nextStatus, this.profileId, expectedRevision);
      const task = parseTask({ ...current!, status: nextStatus, revision: current!.revision + 1, inputRevision: current!.inputRevision + (nextStatus === 'needs_input' ? 1 : 0) });
      return this.update(task, event, 'transition');
    });
  }
  /** Projection and the executor lease check commit in the same task database transaction. */
  transitionWithLease(taskId: string, expectedRevision: number, nextStatus: TaskStatus, event: Event, lease: { owner: string; token: number }): Task {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT owner, token FROM lease WHERE name = 'worker'").get() as { owner: string; token: number } | undefined;
      if (!lease.token || row?.owner !== lease.owner || row.token !== lease.token) throw new Error('lease_lost');
      const current = this.get(taskId);
      assertTaskTransition(current, nextStatus, this.profileId, expectedRevision);
      const task = parseTask({ ...current!, status: nextStatus, revision: current!.revision + 1, inputRevision: current!.inputRevision + (nextStatus === 'needs_input' ? 1 : 0) });
      return this.update(task, event, 'transition');
    });
  }
  respond(responseInput: TaskResponse, event: Event): Task {
    return this.transaction(() => {
      if (!responseInput || responseInput.profileId !== this.profileId) throw new TypeError('Invalid response profile');
      const current = this.get(responseInput.taskId);
      const response = parseTaskResponse(responseInput, current);
      const task = parseTask({ ...current!, status: 'working', revision: current!.revision + 1 });
      this.db.prepare('INSERT INTO responses VALUES (?, ?, ?, ?)').run(this.profileId, task.taskId, response.inputRevision, response.text);
      return this.update(task, event, 'respond');
    });
  }
  /** Exact accepted answer, never a different input round or profile's text. */
  getResponse(taskId: string, inputRevision: number): string | null {
    if (!Number.isSafeInteger(inputRevision) || inputRevision < 1) throw new TypeError('Invalid response identity');
    const row = this.taskRow('SELECT text FROM responses WHERE profile = ? AND task_id = ? AND input_revision = ?', taskId, inputRevision);
    return row ? String(row.text) : null;
  }
  /** True while this exact revision is still held by a restore; a later revision is never held. */
  restoreHeld(taskId: string, revision: number): boolean {
    return !!this.taskRow('SELECT 1 FROM restore_holds WHERE profile = ? AND task_id = ? AND revision = ?', taskId, revision);
  }
  /** Read-only: held revisions that are still the task's current queued or working revision. */
  restoreHolds(limit = 100): RestoreHold[] {
    this.checkLimit(limit);
    return this.db.prepare(`SELECT h.task_id AS taskId, h.revision AS revision, json_extract(t.snapshot, '$.title') AS title, json_extract(t.snapshot, '$.status') AS status
      FROM restore_holds h JOIN tasks t ON t.profile = h.profile AND t.id = h.task_id
      WHERE h.profile = ? AND json_extract(t.snapshot, '$.revision') = h.revision AND json_extract(t.snapshot, '$.status') IN ('queued', 'working') ORDER BY h.task_id LIMIT ?`)
      .all(this.profileId, limit).map(row => ({ taskId: String(row.taskId), revision: Number(row.revision), title: String(row.title), status: row.status as RestoreHold['status'] }));
  }
  /**
   * The operator's reconciliation of one held revision: it ends as failed without running again (a queued one passes
   * through working, as the executor's own refusal does). Requeueing the failed task is a new, unheld revision.
   */
  reconcileRestored(taskId: string, revision: number, event: (sequence: number, note: string) => Event): Task {
    return this.transaction(() => {
      if (!this.restoreHeld(taskId, revision)) throw new TypeError('Task revision is not held by a restore');
      let current = this.get(taskId);
      if (current?.status === 'queued') {
        assertTaskTransition(current, 'working', this.profileId, revision);
        current = this.update(parseTask({ ...current, status: 'working', revision: current.revision + 1 }), event(this.nextSequence(), 'Restaurada do backup; conferida pelo operador.'), 'transition');
      }
      assertTaskTransition(current, 'failed', this.profileId, current?.revision ?? revision);
      const task = this.update(parseTask({ ...current!, status: 'failed', revision: current!.revision + 1 }),
        event(this.nextSequence(), 'Restaurada do backup e encerrada pelo operador sem repetir. Recoloque na fila para gerar de novo.'), 'transition');
      this.db.prepare('DELETE FROM restore_holds WHERE profile = ? AND task_id = ?').run(this.profileId, taskId);
      return task;
    });
  }
  /** The event that created the task: its channel and source decide what may act on it. */
  creation(taskId: string): StoredEvent | null {
    const row = this.taskRow("SELECT payload FROM events WHERE profile = ? AND json_extract(payload, '$.event.taskId') = ? AND json_extract(payload, '$.operation') = 'create' LIMIT 1", taskId);
    return row ? JSON.parse(String(row.payload)) as StoredEvent : null;
  }
  close(): void { this.db.close(); }
}
