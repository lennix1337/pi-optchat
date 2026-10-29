import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { EffectRequest } from '../policy/gateway.ts';

/** Host-owned policy and adapter; dispatch must perform exactly one gateway dispatch. */
export type ToolEffectPort = {
  prepare(request: EffectRequest): { decision: 'allow' } | { decision: 'review'; reviewId: string };
  status(operationId: string): 'absent' | 'uncertain' | 'response_recorded';
  ready(request: EffectRequest, reviewId: string): boolean;
  dispatch(request: EffectRequest, reviewId: string): Promise<unknown>;
};
export type ToolEffectState = 'preparing' | 'waiting' | 'dispatching' | 'done' | 'cancelled' | 'uncertain' | 'failed';
export type PendingToolEffect = { id: string; taskId: string; revision: number; reviewId: string | null; state: ToolEffectState; request: EffectRequest; result: unknown };
type Row = { id: string; task_id: string; revision: number; review_id: string | null; state: ToolEffectState; request: string; result: string | null };

/** Private durable handoff; the caller must fence task revisions against the owning task store. */
export class ToolEffects {
  private readonly db: DatabaseSync;
  private readonly port: ToolEffectPort;
  private readonly current: (taskId: string, revision: number) => boolean;
  readonly databasePath: string;
  constructor(databasePath: string, port: ToolEffectPort, current: (taskId: string, revision: number) => boolean) {
    this.port = port;
    this.current = current;
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'").get()) {
      this.db.close();
      throw new Error('tool_task_database_required');
    }
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS tool_effects
      (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL, review_id TEXT, state TEXT NOT NULL, request TEXT NOT NULL, result TEXT)`);
  }
  private getRow(id: string): Row {
    const row = this.db.prepare('SELECT * FROM tool_effects WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error('unknown_tool_effect');
    return row;
  }
  private decode(row: Row): PendingToolEffect {
    const data = JSON.parse(row.request) as Omit<EffectRequest, 'payload'> & { payload: string };
    return { id: row.id, taskId: row.task_id, revision: row.revision, reviewId: row.review_id, state: row.state,
      request: { ...data, payload: Buffer.from(data.payload, 'base64') }, result: row.result === null ? null : JSON.parse(row.result) };
  }
  get(id: string): PendingToolEffect { return this.decode(this.getRow(id)); }
  find(id: string): PendingToolEffect | undefined {
    const row = this.db.prepare('SELECT * FROM tool_effects WHERE id = ?').get(id) as Row | undefined;
    return row ? this.decode(row) : undefined;
  }
  pending(): PendingToolEffect[] {
    return (this.db.prepare("SELECT * FROM tool_effects WHERE state IN ('preparing','waiting','dispatching','uncertain') ORDER BY rowid").all() as Row[]).map(row => this.decode(row));
  }
  /** Only host-created browser_text requests are accepted; task data cannot select a host adapter. */
  prepare(request: EffectRequest, revision: number, id: string = randomUUID()): PendingToolEffect {
    if (request.adapter !== 'computer' || request.action !== 'browser_text' || request.payload.length > 1000 || !Number.isSafeInteger(revision) || revision < 1 || !this.current(request.taskId, revision)) throw new Error('tool_not_admitted');
    const encoded = JSON.stringify({ ...request, payload: Buffer.from(request.payload).toString('base64') });
    const existing = this.db.prepare('SELECT * FROM tool_effects WHERE id = ?').get(id) as Row | undefined;
    if (existing) {
      if (existing.request !== encoded || existing.revision !== revision || existing.task_id !== request.taskId) throw new Error('tool_conflict');
      return this.decode(existing);
    }
    this.db.prepare("INSERT INTO tool_effects VALUES (?, ?, ?, NULL, 'preparing', ?, NULL)").run(id, request.taskId, revision, encoded);
    return this.reprepare(id);
  }
  /** Reconstructs a lost review only before any dispatch; never grants authority. */
  reprepare(id: string): PendingToolEffect {
    const item = this.get(id);
    if (!['preparing', 'waiting'].includes(item.state) || !this.current(item.taskId, item.revision) || this.port.status(item.request.operationId) !== 'absent') throw new Error('tool_stale');
    const decision = this.port.prepare(item.request);
    if (decision.decision !== 'review') throw new Error('tool_review_required');
    this.db.prepare("UPDATE tool_effects SET state = 'waiting', review_id = ? WHERE id = ? AND state IN ('preparing','waiting')").run(decision.reviewId, id);
    return this.get(id);
  }
  /** Returns false once irreversible dispatch admission has begun. */
  cancel(id: string): boolean {
    return this.db.prepare("UPDATE tool_effects SET state = 'cancelled' WHERE id = ? AND state IN ('preparing','waiting')").run(id).changes === 1;
  }
  /** A crash at dispatch is uncertain, never automatically resent. */
  async resume(id: string, lease: { owner: string; token: number }): Promise<PendingToolEffect> {
    this.db.exec('BEGIN IMMEDIATE');
    let item: PendingToolEffect;
    try {
      item = this.get(id);
      const owner = this.db.prepare("SELECT owner, token FROM lease WHERE name = 'worker'").get() as { owner: string; token: number } | undefined;
      if (!lease.token || owner?.owner !== lease.owner || owner.token !== lease.token) throw new Error('lease_lost');
      const row = this.db.prepare('SELECT snapshot FROM tasks WHERE profile = ? AND id = ?').get(item.request.profileId, item.taskId) as { snapshot: string } | undefined;
      const task = row ? JSON.parse(row.snapshot) as { status?: unknown; revision?: unknown } : undefined;
      if (item.state !== 'waiting' || task?.status !== 'working' || task.revision !== item.revision || !this.current(item.taskId, item.revision) || this.port.status(item.request.operationId) !== 'absent') throw new Error('tool_stale');
      if (!item.reviewId || !this.port.ready(item.request, item.reviewId)) { this.db.exec('COMMIT'); return item; }
      const claim = this.db.prepare("UPDATE tool_effects SET state = 'dispatching' WHERE id = ? AND state = 'waiting'").run(id);
      if (claim.changes !== 1) throw new Error('tool_stale');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try {
      const result = await this.port.dispatch(item.request, item.reviewId!);
      const encoded = JSON.stringify(result ?? null);
      if (encoded.length > 65536) throw new Error('tool_result_too_large');
      this.db.prepare("UPDATE tool_effects SET state = 'done', result = ? WHERE id = ? AND state = 'dispatching'").run(encoded, id);
    } catch {
      this.db.prepare("UPDATE tool_effects SET state = 'uncertain' WHERE id = ? AND state = 'dispatching'").run(id);
    }
    return this.get(id);
  }
  close(): void { this.db.close(); }
}
