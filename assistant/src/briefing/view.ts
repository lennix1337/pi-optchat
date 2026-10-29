import type { Briefing } from './compose.ts';
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The panel consumes stored data only, never a source refresh or instruction from mail. */
export type StoredBriefings = { latest(): Promise<unknown | null> };
const string = (v: unknown): v is string => typeof v === 'string' && v.length <= 4000;
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
export function briefingView(value: unknown, profileId: string): Briefing | null {
  if (value === null) return null;
  if (!record(value) || value.version !== 1 || value.profileId !== profileId || !string(value.briefingId)
    || !['daily', 'on_demand'].includes(String(value.kind)) || !string(value.localDate) || !string(value.timeZone) || !string(value.createdAt)
    || !integer(value.taskSequence) || !integer(value.distractions) || !Array.isArray(value.sources) || value.sources.length > 100
    || !Array.isArray(value.items) || value.items.length > 1000) throw new Error('invalid_briefing');
  const sources = value.sources.map(s => {
    if (!record(s) || !string(s.sourceId) || !['ok', 'partial', 'unavailable'].includes(String(s.state)) || !(s.error === null || string(s.error))) throw new Error('invalid_briefing');
    return { sourceId: s.sourceId, state: s.state, error: s.error };
  });
  const items = value.items.map(i => {
    if (!record(i) || !string(i.itemId) || !string(i.title) || !string(i.sourceRef) || !string(i.reason)
      || !['tasks', 'agenda', 'messages', 'changes'].includes(String(i.section)) || !['urgent', 'normal', 'low'].includes(String(i.urgency))
      || !['high', 'medium', 'low'].includes(String(i.uncertainty)) || typeof i.untrusted !== 'boolean' || typeof i.startable !== 'boolean') throw new Error('invalid_briefing');
    return { itemId: i.itemId, section: i.section, title: i.title, sourceRef: i.sourceRef, reason: i.reason, urgency: i.urgency, uncertainty: i.uncertainty, untrusted: i.untrusted, startable: i.startable };
  });
  return { version: 1, profileId, briefingId: value.briefingId, kind: value.kind, localDate: value.localDate, timeZone: value.timeZone,
    createdAt: value.createdAt, taskSequence: value.taskSequence, distractions: value.distractions, sources, items } as Briefing;
}
