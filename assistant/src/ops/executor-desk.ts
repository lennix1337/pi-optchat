import { randomUUID } from 'node:crypto';
import type { Config } from '../main.ts';
import type { Event } from '../contracts/events.ts';
import type { Task } from '../contracts/tasks.ts';
import type { Gateway } from '../policy/gateway.ts';
import { ToolEffects } from '../runtime/tool-effects.ts';
import { openToolGateway } from '../runtime/tool-service.ts';
import { TaskStore, type RestoreHold } from '../store/db.ts';

export type PendingReview = { reviewId: string; effectId: string; taskId: string; title: string; revision: number; adapter: string; action: string; account: string; destination: string; expiresAt: number; text: string };

/**
 * The local operator's side of the executor: reconcile task revisions a restore held, and decide the preview reviews the
 * executor opened. Only the `executor.mjs` script constructs this, after a typed confirmation in a real terminal; the
 * service never does, and neither does any model text, HTTP route or panel. The review authority lives only in this object.
 */
export class ExecutorDesk {
  private readonly store: TaskStore;
  private readonly gateway: Gateway;
  private readonly effects: ToolEffects;
  private readonly authority = Object.freeze({});
  private readonly profileId: string;
  constructor(config: Pick<Config, 'profileId' | 'databasePath'>) {
    this.profileId = config.profileId;
    this.store = new TaskStore(config.databasePath, config.profileId);
    try {
      this.gateway = openToolGateway(config, this.authority);
      // Listing only: this desk never prepares or dispatches an effect.
      const refuse = () => { throw new Error('operator_desk_read_only'); };
      this.effects = new ToolEffects(config.databasePath, { prepare: refuse, status: id => this.gateway.status(id), ready: () => false, dispatch: refuse }, () => false);
    } catch (error) { this.store.close(); throw error; }
  }
  restored(): RestoreHold[] { return this.store.restoreHolds(); }
  /** Ends one held revision as failed without running it; requeue it afterwards for a fresh, unheld revision. */
  reconcile(taskId: string, revision: number): Task {
    const channelId = this.store.creation(taskId)?.event.channelId ?? 'operator';
    return this.store.reconcileRestored(taskId, revision, (sequence, note): Event => {
      const id = randomUUID();
      return { version: 1, eventId: id, correlationId: id, profileId: this.profileId, taskId, sessionId: 'executor-desk', channelId, runId: id,
        source: { actorId: 'operator', sourceKind: 'trusted-local-human', sourceEventId: id }, observedAt: new Date().toISOString(), sequence, evidence: { kind: 'observed', reference: note } };
    });
  }
  /** Reviews still awaiting a decision, with the exact text the operator would let the isolated browser open. */
  reviews(): PendingReview[] {
    const found: PendingReview[] = [];
    for (const effect of this.effects.pending()) {
      if (effect.state !== 'waiting' || !effect.reviewId) continue;
      const pending = this.gateway.pendingReview(effect.reviewId, effect.request);
      if (!pending) continue;
      found.push({ reviewId: effect.reviewId, effectId: effect.id, taskId: effect.taskId, title: this.store.get(effect.taskId)?.title ?? '', revision: effect.revision,
        adapter: pending.metadata.adapter, action: pending.metadata.action, account: pending.metadata.account, destination: pending.metadata.destination,
        expiresAt: pending.metadata.expiresAt, text: Buffer.from(pending.payload).toString('utf8') });
    }
    return found;
  }
  /** Decides only a review that `reviews()` lists; the caller must have shown it to the operator and obtained confirmation. */
  decide(reviewId: string, decision: 'approve' | 'deny'): void {
    if (!this.reviews().some(review => review.reviewId === reviewId)) throw new Error('review_not_pending');
    this.gateway.decide(reviewId, decision, this.authority);
  }
  close(): void { this.effects.close(); this.gateway.close(); this.store.close(); }
}
