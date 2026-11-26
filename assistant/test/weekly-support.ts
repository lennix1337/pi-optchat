import { BriefingComposer, type Briefing } from '../src/briefing/compose.ts';
import type { Event } from '../src/contracts/events.ts';
import type { Task } from '../src/contracts/tasks.ts';
import type { GoogleRig } from './google-support.ts';

export const TZ = 'America/Sao_Paulo';
export const SUNDAY_EVENING = Date.parse('2026-11-01T21:30:00.000Z');
export const rules = { trustedSenders: ['boss@dentai.example.test'] };

export function composer(rig: GoogleRig, connections = ['personal', 'dentai']) {
  const c = new BriefingComposer({ databasePath: rig.databasePath, profileId: 'p', operatorAuthority: rig.authority, timeZone: TZ, store: rig.store, google: rig.google, connections, rules, now: () => rig.clock.now });
  rig.defer(() => c.close());
  return c;
}
export const event = (id: string, summary: string, start: string, end: string, iCalUID?: string) => ({ id, summary, status: 'confirmed', updated: '2026-10-01T00:00:00.000Z', start: { dateTime: start }, end: { dateTime: end }, ...(iCalUID ? { iCalUID } : {}) });
export const section = (b: Briefing, name: string) => b.items.filter(i => i.section === name);

function openTask(rig: GoogleRig, taskId: string, title: string, status: Task['status']) {
  const task: Task = { version: 1, profileId: 'p', taskId, title, status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: taskId };
  const e = (id: string): Event => ({ version: 1, eventId: id, profileId: 'p', sessionId: 's', channelId: 'c', taskId, runId: 'r', source: { actorId: 'lucas', sourceKind: 'trusted-local-human', sourceEventId: id === `e-${taskId}` ? taskId : id }, observedAt: '2026-10-30T10:00:00.000Z', sequence: rig.store.nextSequence(), correlationId: 'c', evidence: { kind: 'observed', reference: 'test' } });
  rig.store.create(task, e(`e-${taskId}`));
  rig.store.transition(taskId, 1, 'working', e(`e2-${taskId}`));
  rig.store.transition(taskId, 2, status, e(`e3-${taskId}`));
}

export async function seed(rig: GoogleRig) {
  await rig.connect('personal', 'personal');
  await rig.connect('dentai', 'dentai');
  openTask(rig, 't-open', 'Send the invoice', 'needs_input');
  openTask(rig, 't-done', 'Already finished', 'succeeded');
  rig.fake.mail.personal.push(
    { id: 'w1', from: 'Ana <ana@example.test>', subject: 'Proposal for review', body: 'Can you look?', receivedAt: '2026-10-30T12:00:00.000Z' },
    { id: 'w2', from: 'Bob <bob@example.test>', subject: 'Lunch?', body: 'Thursday?', threadId: 'thread-bob', receivedAt: '2026-10-29T12:00:00.000Z' },
    { id: 'w2-reply', from: 'Me <me@example.test>', subject: 'Re: Lunch?', body: 'Sure', labels: ['SENT'], unlisted: true, threadId: 'thread-bob', receivedAt: '2026-10-30T09:00:00.000Z' },
    { id: 'e1', from: 'Eve <eve@example.test>', subject: 'Budget', body: 'First ask', threadId: 'thread-eve', receivedAt: '2026-10-28T12:00:00.000Z' },
    { id: 'e1-reply', from: 'Me <me@example.test>', subject: 'Re: Budget', body: 'Done', labels: ['SENT'], unlisted: true, threadId: 'thread-eve', receivedAt: '2026-10-29T12:00:00.000Z' },
    { id: 'e2', from: 'Eve <eve@example.test>', subject: 'Re: Budget', body: 'One more thing', threadId: 'thread-eve', receivedAt: '2026-10-30T15:00:00.000Z' },
    { id: 'promo', from: 'Deals <deals@shop.example.test>', subject: 'Flash sale', body: 'Unsubscribe', labels: ['CATEGORY_PROMOTIONS'], receivedAt: '2026-10-31T08:00:00.000Z' },
    { id: 'old', from: 'Old <old@example.test>', subject: 'Eight days ago', body: 'Hello', receivedAt: '2026-10-23T12:00:00.000Z' },
  );
  rig.fake.mail.dentai.push({ id: 'd1', from: 'Rita <boss@dentai.example.test>', subject: 'Sign the contract today', body: 'Please.', receivedAt: '2026-10-31T10:00:00.000Z' });
  rig.fake.events.personal.push(
    event('planning', 'Planning', '2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z', 'planning@uid'),
    event('retro-a', 'Retro', '2026-11-04T15:00:00Z', '2026-11-04T16:00:00Z', 'retro-a@uid'),
    event('review', 'Review', '2026-11-02T13:30:00Z', '2026-11-02T14:00:00Z'),
    event('lunch', 'Lunch', '2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'),
    event('sync', 'Sync', '2026-11-03T16:00:00Z', '2026-11-03T16:30:00Z'),
    event('alone', 'Dentist', '2026-11-05T18:00:00Z', '2026-11-05T19:00:00Z'),
    event('standup-1', 'Standup', '2026-11-06T12:00:00Z', '2026-11-06T12:30:00Z'),
    event('standup-2', 'Standup', '2026-11-06T12:00:00Z', '2026-11-06T12:30:00Z'),
    event('offsite', 'Offsite', '2026-11-05T20:00:00Z', '2026-11-05T21:00:00Z'),
    event('later', 'The week after', '2026-11-09T15:00:00Z', '2026-11-09T16:00:00Z'),
  );
  rig.fake.events.dentai.push(
    event('call', 'Client call', '2026-11-02T12:30:00Z', '2026-11-02T13:30:00Z'),
    event('planning-copy', 'Planning', '2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z', 'planning@uid'),
    event('retro-b', 'Retro', '2026-11-04T15:00:00Z', '2026-11-04T16:00:00Z', 'retro-b@uid'),
    event('offsite-copy', 'Offsite', '2026-11-05T20:00:00Z', '2026-11-05T21:00:00Z'),
  );
}
