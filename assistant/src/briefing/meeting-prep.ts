import type { CalendarAttendee, CalendarEvent, MailMessage } from '../connectors/google.ts';
import { sha256 } from '../hash.ts';
import { boundedText } from '../limits.ts';
import { zonedInstant } from '../routines/schedule.ts';
import { senderAddress, triage, type TriageRules } from './triage.ts';

export type MeetingPrepCard = {
  cardId: string; title: string; start: string; when: string; allDay: boolean; untrusted: true;
  attendees: CalendarAttendee[];
  threads: { subject: string; receivedAt: string; sourceRef: string }[];
  openItems: { title: string; sourceRef: string; reason: 'open_task' | 'unread_thread' }[];
};
type OpenTask = { title: string; sourceRef: string };

export function agendaInstant(value: string, timeZone: string): number {
  if (value.length !== 10) return Date.parse(value);
  const [year, month, day] = value.split('-').map(Number);
  return zonedInstant(year, month, day, 0, 0, timeZone);
}

export function meetingId(event: CalendarEvent): string {
  return `meeting-prep-${sha256(JSON.stringify([event.ref.connectionId, event.ref.id, event.start])).slice(0, 32)}`;
}

export function byMeetingStart(a: MeetingPrepCard, b: MeetingPrepCard): number {
  return (a.start + a.cardId).localeCompare(b.start + b.cardId);
}

const short = (text: string) => boundedText(text, 120);
const topic = (text: string) => text.normalize('NFKC').toLowerCase().replace(/^(?:(?:re|fwd?|aw|enc):\s*)+/u, '').trim().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const safeSubject = (message: MailMessage, rules: TriageRules) => triage(message, rules).private ? '[private content withheld]' : short(message.subject || '(no subject)');

export function buildMeetingCard(event: CalendarEvent, messages: MailMessage[], tasks: OpenTask[], timeZone: string, rules: TriageRules): MeetingPrepCard {
  const name = topic(event.title);
  const people = new Set(event.attendees.map(attendee => attendee.email));
  const groups = new Map<string, { latest: MailMessage; matched: boolean }>();
  for (const message of messages) {
    const recipients = message.to.match(/(?:"(?:[^"\\]|\\.)*"|[^",])+/gu) ?? [];
    const participants = [senderAddress(message.from), ...recipients.map(value => senderAddress(value.trim()))];
    const related = participants.some(address => people.has(address)) || (name !== '' && name === topic(message.subject));
    const group = groups.get(message.threadId);
    if (!group) groups.set(message.threadId, { latest: message, matched: related });
    else {
      if (message.receivedAt > group.latest.receivedAt) group.latest = message;
      group.matched ||= related;
    }
  }
  const threads = [...groups.values()].filter(group => group.matched).map(group => group.latest)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.threadId.localeCompare(b.threadId)).slice(0, 3)
    .map(message => ({ subject: safeSubject(message, rules), receivedAt: message.receivedAt, sourceRef: `gmail:${event.ref.connectionId}:${message.ref.id}`, unread: message.labels.includes('UNREAD') }));
  const openItems: MeetingPrepCard['openItems'] = [];
  for (const task of tasks) {
    if (name.length >= 4 && ` ${topic(task.title)} `.includes(` ${name} `)) openItems.push({ title: short(task.title), sourceRef: task.sourceRef, reason: 'open_task' });
    if (openItems.length === 3) break;
  }
  for (const thread of threads) {
    if (openItems.length === 3) break;
    if (thread.unread) openItems.push({ title: thread.subject, sourceRef: thread.sourceRef, reason: 'unread_thread' });
  }
  return {
    cardId: meetingId(event), title: short(event.title), start: new Date(agendaInstant(event.start, timeZone)).toISOString(),
    when: event.localStart === null ? event.localDate : `${event.localDate} ${event.localStart}`, allDay: event.allDay, untrusted: true,
    attendees: event.attendees, threads: threads.map(({ unread: _unread, ...thread }) => thread), openItems,
  };
}
