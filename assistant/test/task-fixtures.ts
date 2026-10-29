import type { SourceKind } from '../src/contracts/events.ts';

/** A version-1 queued task as the store accepts it on create. */
export function queuedTask(profileId: string, taskId: string, title: string, sourceEventId: string) {
  return { version: 1 as const, profileId, taskId, title, status: 'queued' as const, verification: 'not_verified' as const, revision: 1, inputRevision: 1, sourceEventId };
}

type EventIds = { eventId: string; sourceEventId: string; correlationId: string; actorId: string; sourceKind: SourceKind; reference: string };
/** A version-1 observed store event for `taskId` at `sequence`; ids are explicit so tests control replay and conflicts. */
export function storeEvent(profileId: string, taskId: string, sequence: number, ids: EventIds) {
  return { version: 1 as const, eventId: ids.eventId, correlationId: ids.correlationId, profileId, taskId, sessionId: 'session', channelId: 'channel', runId: 'run',
    source: { actorId: ids.actorId, sourceKind: ids.sourceKind, sourceEventId: ids.sourceEventId }, observedAt: '2026-10-28T12:00:00Z', sequence,
    evidence: { kind: 'observed' as const, reference: ids.reference } };
}
