import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { snapshot, type EffectRequest, type EffectMetadata } from './grants.ts';
export type { EffectRequest, EffectMetadata } from './grants.ts';
type Decision = 'allow' | 'review' | 'deny';
export type GatewayOptions = { databasePath: string; profileId: string; operatorAuthority: object; policy: (metadata: EffectMetadata) => Decision; inspect: (bytes: Uint8Array) => { decision: Decision; reasons: readonly string[] }; now?: () => number };
export type BoundedRule = { scope: 'rule'; uses: number; expiresAt: number };

export class Gateway {
  private db: DatabaseSync;
  private now: () => number;
  private options: GatewayOptions;
  constructor(options: GatewayOptions) {
    this.options = { ...options };
    if (!options.operatorAuthority || typeof options.operatorAuthority !== 'object' || typeof options.profileId !== 'string' || !options.profileId.trim()) throw new Error('invalid_options');
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, binding TEXT NOT NULL, operation TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, binding TEXT NOT NULL, operation TEXT, expires INTEGER NOT NULL, remaining INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS intents (operation TEXT PRIMARY KEY, state TEXT NOT NULL);`);
  }
  private evaluate(request: EffectRequest) {
    return this.evaluateSnapshot(snapshot(request, this.options.profileId, this.now()));
  }
  private evaluateSnapshot(item: ReturnType<typeof snapshot>) {
    if (item.metadata.expiresAt <= this.now()) throw new Error('invalid_request');
    let policy: Decision; let inspection: Decision;
    try {
      policy = this.options.policy(Object.freeze({ ...item.metadata }));
      inspection = this.options.inspect(Buffer.from(item.payload)).decision;
    } catch { throw new Error('policy_error'); }
    if (!['allow', 'review', 'deny'].includes(policy) || !['allow', 'review', 'deny'].includes(inspection)) throw new Error('policy_error');
    if (policy === 'deny' || inspection === 'deny') throw new Error('denied');
    return { ...item, review: policy === 'review' || inspection === 'review' };
  }
  /** A review result carries owned copies of the exact bound metadata and bytes, so a reviewer sees what dispatch will send. */
  prepare(request: EffectRequest): { decision: 'allow'; reviewId?: undefined } | { decision: 'review'; reviewId: string; metadata: Readonly<EffectMetadata>; payload: Uint8Array } {
    const item = this.evaluate(request);
    if (!item.review) return { decision: 'allow' };
    const id = randomUUID();
    this.db.prepare('INSERT INTO reviews VALUES (?, ?, ?, ?, ?)').run(id, item.binding, item.operation, item.metadata.expiresAt, 'pending');
    return { decision: 'review', reviewId: id, metadata: Object.freeze({ ...item.metadata }), payload: Buffer.from(item.payload) };
  }
  /** Read-only reconstruction of one exact pending review; no decision or preparation occurs. */
  pendingReview(reviewId: string, request: EffectRequest): { metadata: Readonly<EffectMetadata>; payload: Uint8Array } | undefined {
    let item: ReturnType<typeof snapshot>;
    try { item = snapshot(request, this.options.profileId, this.now()); }
    catch (error) { if (error instanceof Error && error.message === 'invalid_request') return undefined; throw error; }
    const row = this.db.prepare("SELECT 1 FROM reviews WHERE id = ? AND binding = ? AND operation = ? AND expires > ? AND state = 'pending'").get(reviewId, item.binding, item.operation, this.now());
    return row ? { metadata: Object.freeze({ ...item.metadata }), payload: Buffer.from(item.payload) } : undefined;
  }
  decide(reviewId: string, decision: 'approve' | 'deny', authority: object, rule?: BoundedRule): void {
    if (authority !== this.options.operatorAuthority) throw new Error('unauthorized');
    if (decision !== 'approve' && decision !== 'deny') throw new Error('invalid_decision');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const review = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId) as { binding: string; operation: string; expires: number; state: string } | undefined;
      const now = this.now();
      if (!review || review.state !== 'pending' || review.expires <= now) throw new Error('invalid_review');
      if (rule && (decision !== 'approve' || rule.scope !== 'rule' || !Number.isSafeInteger(rule.uses) || rule.uses < 1 || rule.uses > 100 || !Number.isSafeInteger(rule.expiresAt) || rule.expiresAt <= now || rule.expiresAt > review.expires)) throw new Error('invalid_rule');
      this.db.prepare('UPDATE reviews SET state = ? WHERE id = ?').run(decision === 'approve' ? 'approved' : 'denied', reviewId);
      if (decision === 'approve') this.db.prepare('INSERT INTO grants (id,binding,operation,expires,remaining) VALUES (?,?,?,?,?)').run(reviewId, review.binding, rule ? null : review.operation, rule?.expiresAt ?? review.expires, rule?.uses ?? 1);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Checks the exact one-use review without consuming it; dispatch revalidates atomically. */
  reviewReady(request: EffectRequest, reviewId: string): boolean {
    const item = this.evaluate(request);
    return !!this.db.prepare('SELECT 1 FROM grants WHERE id = ? AND binding = ? AND operation = ? AND revoked = 0 AND remaining > 0 AND expires > ?').get(reviewId, item.binding, item.operation, this.now());
  }
  /** Forces consumption of this exact operation-bound review even if policy now allows it. */
  dispatchReviewed<T>(request: EffectRequest, reviewId: string, invoke: (bytes: Uint8Array, metadata: Readonly<EffectMetadata>) => T | Promise<T>): Promise<T> {
    return this.dispatchInternal(request, invoke, reviewId);
  }
  // Adapters must use both callback arguments as the authoritative effect, not the caller's request.
  async dispatch<T>(request: EffectRequest, invoke: (bytes: Uint8Array, metadata: Readonly<EffectMetadata>) => T | Promise<T>): Promise<T> {
    return this.dispatchInternal(request, invoke);
  }
  private async dispatchInternal<T>(request: EffectRequest, invoke: (bytes: Uint8Array, metadata: Readonly<EffectMetadata>) => T | Promise<T>, reviewId?: string): Promise<T> {
    const item = this.evaluate(request);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const admission = this.evaluateSnapshot(item);
      if (this.db.prepare('SELECT 1 FROM intents WHERE operation = ?').get(item.operation)) throw new Error('operation_already_dispatched');
      if (admission.review || reviewId !== undefined) {
        const grant = reviewId !== undefined
          ? this.db.prepare('SELECT id FROM grants WHERE id = ? AND binding = ? AND operation = ? AND revoked = 0 AND remaining > 0 AND expires > ?').get(reviewId, item.binding, item.operation, this.now()) as { id: string } | undefined
          : this.db.prepare('SELECT id FROM grants WHERE binding = ? AND (operation = ? OR operation IS NULL) AND revoked = 0 AND remaining > 0 AND expires > ? ORDER BY operation IS NULL, expires LIMIT 1').get(item.binding, item.operation, this.now()) as { id: string } | undefined;
        if (!grant) throw new Error('approval_required');
        const result = this.db.prepare('UPDATE grants SET remaining = remaining - 1 WHERE id = ? AND revoked = 0 AND remaining > 0 AND expires > ?').run(grant.id, this.now());
        if (result.changes !== 1) throw new Error('approval_required');
      }
      if (item.metadata.expiresAt <= this.now()) throw new Error('invalid_request');
      this.db.prepare('INSERT INTO intents VALUES (?, ?)').run(item.operation, 'uncertain');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try {
      const result = await invoke(item.payload, Object.freeze({ ...item.metadata }));
      this.db.prepare('UPDATE intents SET state = ? WHERE operation = ?').run('response_recorded', item.operation);
      return result;
    } catch { throw new Error('effect_uncertain'); }
  }
  status(operationId: string): 'uncertain' | 'response_recorded' | 'absent' {
    // Reuse boundary validation and hashing without storing the operation identifier.
    const item = snapshot({ version: 1, operationId, profileId: this.options.profileId, sessionId: 'status', taskId: 'status', runId: 'status', adapter: 'status', action: 'status', account: 'status', destination: 'status', policyVersion: 'status', expiresAt: Number.MAX_SAFE_INTEGER, payload: new Uint8Array() }, this.options.profileId, this.now());
    const row = this.db.prepare('SELECT state FROM intents WHERE operation = ?').get(item.operation) as { state: 'uncertain' | 'response_recorded' } | undefined;
    return row?.state ?? 'absent';
  }
  revoke(reviewId: string, authority: object): void {
    if (authority !== this.options.operatorAuthority) throw new Error('unauthorized');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE reviews SET state = ? WHERE id = ? AND state = ?').run('revoked', reviewId, 'pending');
      this.db.prepare('UPDATE grants SET revoked = 1 WHERE id = ?').run(reviewId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
export function createGateway(options: GatewayOptions): Gateway { return new Gateway(options); }
