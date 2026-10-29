import { randomUUID } from 'node:crypto';
import type { TaskStore } from '../store/db.ts';
import type { Event } from '../contracts/events.ts';
import type { EffectRequest } from '../policy/gateway.ts';
import { ToolEffects, type PendingToolEffect } from './tool-effects.ts';

/** Host-created requests only; model text is data, never a review decision. */
export class ToolTask {
  readonly store: TaskStore;
  readonly effects: ToolEffects;
  readonly profileId: string;
  readonly channelId: string;
  constructor(store: TaskStore, effects: ToolEffects, profileId: string, channelId: string) {
    if (!store.matchesProfile(profileId) || !store.matchesDatabase(effects.databasePath)) throw new Error('tool_database_mismatch');
    this.store = store; this.effects = effects; this.profileId = profileId; this.channelId = channelId;
  }
  private event(taskId: string, message: string): Event {
    const id = randomUUID();
    return { version: 1, eventId: id, correlationId: id, profileId: this.profileId, taskId, sessionId: 'tool-executor', channelId: this.channelId,
      runId: id, source: { actorId: 'tool-executor', sourceKind: 'worker', sourceEventId: id }, observedAt: new Date().toISOString(),
      sequence: this.store.nextSequence(), evidence: { kind: 'observed', reference: message } };
  }
  prepare(request: EffectRequest, revision: number, id?: string): PendingToolEffect {
    const task = this.store.get(request.taskId);
    if (!task || task.profileId !== this.profileId || task.status !== 'working' || task.revision !== revision) throw new Error('tool_stale');
    return this.effects.prepare(request, revision, id);
  }
  async resume(id: string, lease: { owner: string; token: number }): Promise<PendingToolEffect> {
    const existing = this.effects.get(id);
    const item = existing.state === 'done' ? existing : await this.effects.resume(id, lease);
    if (item.state === 'done') {
      const task = this.store.get(item.taskId);
      if (task?.status === 'working' && task.revision === item.revision) {
        const output = typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
        this.store.transitionWithLease(task.taskId, task.revision, 'ready_for_review', this.event(task.taskId, `Prévia isolada concluída; não verificada nem enviada:\n${output.slice(0, 3500)}`), lease);
      }
    }
    return item;
  }
}
