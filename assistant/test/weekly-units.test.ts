import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekAgenda, type Briefing } from '../src/briefing/compose.ts';
import { weeklyNotice, weeklySchedule } from '../src/briefing/weekly.ts';
import type { CalendarEvent } from '../src/connectors/google.ts';

const meeting = (id: string, uid: string | null, start = '2026-11-02T12:00:00Z'): CalendarEvent => ({
  ref: { id } as CalendarEvent['ref'], title: 'Planning', start, end: '2026-11-02T13:00:00Z', allDay: false, localDate: '2026-11-02', localStart: '09:00', recurring: false, uid, updated: null,
});

test('one invitation on three calendars is listed once, with or without an iCalUID, and raises no conflict', () => {
  for (const uid of ['planning@uid', null]) {
    const items = weekAgenda(['a', 'b', 'c'].map(connectionId => ({ connectionId, event: meeting(`${connectionId}-1`, uid) })));
    assert.deepEqual(items.map(i => [i.sourceRef, i.reason]), [['calendar:a:a-1', 'event']], `uid ${uid}`);
  }
});

test('a copy merges into one meeting per calendar, so two meetings on one calendar stay two', () => {
  const found = [{ connectionId: 'a', event: meeting('a-1', null) }, { connectionId: 'a', event: meeting('a-2', null) }, { connectionId: 'b', event: meeting('b-1', null) }, { connectionId: 'b', event: meeting('b-2', null) }];
  assert.deepEqual(weekAgenda(found).map(i => i.sourceRef), ['calendar:a:a-1', 'calendar:a:a-2']);
});

const timed = (id: string, start: string, end: string): CalendarEvent => ({ ...meeting(id, null, start), title: id, end });
const reasons = (...events: CalendarEvent[]) => weekAgenda(events.map(event => ({ connectionId: 'a', event }))).map(i => [i.sourceRef.slice(-1), i.reason]);

test('back to back is the gap to the neighbouring meeting, an overlap is with any earlier one', () => {
  assert.deepEqual(reasons(timed('a', '2026-11-02T12:00:00Z', '2026-11-02T14:00:00Z'), timed('b', '2026-11-02T12:10:00Z', '2026-11-02T12:20:00Z'), timed('c', '2026-11-02T14:02:00Z', '2026-11-02T15:00:00Z')),
    [['a', 'conflict'], ['b', 'conflict'], ['c', 'event']], 'c follows b by hours: only the neighbour counts');
  assert.deepEqual(reasons(timed('a', '2026-11-02T12:00:00Z', '2026-11-02T15:00:00Z'), timed('b', '2026-11-02T12:30:00Z', '2026-11-02T13:00:00Z'), timed('c', '2026-11-02T13:30:00Z', '2026-11-02T14:00:00Z')),
    [['a', 'conflict'], ['b', 'conflict'], ['c', 'conflict']], 'c overlaps a long meeting it is not next to');
  assert.deepEqual(reasons(timed('a', '2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z'), timed('b', '2026-11-02T13:03:00Z', '2026-11-02T14:00:00Z'), timed('c', '2026-11-02T16:00:00Z', '2026-11-02T17:00:00Z')),
    [['a', 'back_to_back'], ['b', 'back_to_back'], ['c', 'event']]);
});

test('an all-day event on two calendars is listed once, with or without an iCalUID, and never flagged', () => {
  const allDay = (id: string, uid: string | null): CalendarEvent => ({ ...meeting(id, uid, '2026-11-04'), end: '2026-11-05', allDay: true, localStart: null, title: 'Holiday' });
  for (const uid of ['holiday@uid', null]) {
    const items = weekAgenda([{ connectionId: 'a', event: allDay('a-1', uid) }, { connectionId: 'b', event: allDay('b-1', uid) }, { connectionId: 'a', event: meeting('m', null, '2026-11-04T12:00:00Z') }]);
    assert.deepEqual(items.map(i => [i.sourceRef, i.reason]).sort(), [['calendar:a:a-1', 'event'], ['calendar:a:m', 'event']], `uid ${uid}`);
  }
});

test('the notice says when a weekly review is missing sources', () => {
  const review = (...states: ('ok' | 'partial' | 'unavailable')[]) => ({ sources: states.map((state, i) => ({ sourceId: `s${i}`, state, error: null })) }) as Briefing;
  assert.equal(weeklyNotice(review('ok', 'partial')), 'weekly_review_ready');
  assert.equal(weeklyNotice(review('ok', 'unavailable')), 'weekly_review_degraded');
});

test('an explicit undefined day or hour is the default, not Sunday by accident or a NaN', () => {
  assert.deepEqual(weeklySchedule({ day: undefined, at: undefined } as never), { day: 0, at: '18:00' });
  assert.deepEqual(weeklySchedule({ day: 'wed', at: undefined } as never), { day: 3, at: '18:00' });
});
