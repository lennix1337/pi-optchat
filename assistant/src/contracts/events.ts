import { object, oneOf, positive, text, timestamp, version } from './validation.ts';

export type SourceKind = 'trusted-local-human' | 'external' | 'worker' | 'model';
export type Source = { actorId: string; sourceKind: SourceKind; sourceEventId: string };
export type Evidence = { kind: 'observed'; reference: string };
export type Event = { version: 1; eventId: string; profileId: string; sessionId: string; channelId: string; taskId: string; runId: string; source: Source; observedAt: string; sequence: number; correlationId: string; evidence: Evidence };
const sourceKinds = oneOf('trusted-local-human', 'external', 'worker', 'model');
export function sourceAuthority(kind: unknown): 'human_intent' | 'untrusted' {
  if (!sourceKinds(kind)) throw new TypeError('Unknown source kind');
  return kind === 'trusted-local-human' ? 'human_intent' : 'untrusted';
}
export function parseEvent(value: unknown): Event {
  object(value, { version, eventId: text, profileId: text, sessionId: text, channelId: text, taskId: text, runId: text, source: v => { try { object(v, { actorId: text, sourceKind: sourceKinds, sourceEventId: text }); return true; } catch { return false; } }, observedAt: timestamp, sequence: positive, correlationId: text, evidence: v => { try { object(v, { kind: oneOf('observed'), reference: text }); return true; } catch { return false; } } });
  return value as Event;
}
export function parseEventSequence(values: unknown, profileId: string, afterSequence: number): Event[] {
  if (!text(profileId) || !Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Array.isArray(values)) throw new TypeError('Invalid event cursor');
  return values.map((value, index) => {
    const event = parseEvent(value);
    if (event.profileId !== profileId || event.sequence !== afterSequence + index + 1) throw new TypeError('Invalid event profile or sequence');
    return event;
  });
}
