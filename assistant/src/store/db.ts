/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { parseEvent, type Event } from '../contracts/events.ts';
import { assertTaskTransition, parseTask, parseTaskResponse, type Task, type TaskResponse, type TaskStatus } from '../contracts/tasks.ts';

export type StoredEvent = { event: Event; operation: 'create' | 'transition' | 'respond'; task: Task };
export type TaskPage = { tasks: Task[]; nextCursor: string | null };

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
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }
  matchesProfile(profileId: string): boolean { return this.profileId === profileId; }
  nextSequence(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE profile = ?').get(this.profileId)!;
    return Number(row.sequence) + 1;
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
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
  get(taskId: string): Task | null {
    if (typeof taskId !== 'string' || !taskId.length) throw new TypeError('Invalid task ID');
    const row = this.db.prepare('SELECT snapshot FROM tasks WHERE profile = ? AND id = ?').get(this.profileId, taskId);
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
  close(): void { this.db.close(); }
}
