import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueOccurrences, nextOccurrence, validateSchedule, zonedInstant } from '../src/routines/schedule.ts';

const utc = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();

test('local wall times resolve per time zone, including half-hour offsets', () => {
  assert.equal(iso(zonedInstant(2026, 10, 28, 7, 0, 'America/Sao_Paulo')), '2026-10-28T10:00:00.000Z');
  assert.equal(iso(zonedInstant(2026, 10, 28, 9, 0, 'Asia/Kolkata')), '2026-10-28T03:30:00.000Z');
  assert.equal(iso(zonedInstant(2026, 10, 28, 9, 0, 'UTC')), '2026-10-28T09:00:00.000Z');
});

test('a time skipped by the spring-forward gap runs one gap later, the next day runs at its normal time', () => {
  const schedule = validateSchedule({ kind: 'daily', at: '02:30', timeZone: 'America/New_York' });
  const before = nextOccurrence(schedule, utc('2026-03-07T00:00:00Z'));
  assert.deepEqual([iso(before.at), before.slot], ['2026-03-07T07:30:00.000Z', '2026-03-07T02:30']);
  const gap = nextOccurrence(schedule, before.at);
  assert.deepEqual([iso(gap.at), gap.slot], ['2026-03-08T07:30:00.000Z', '2026-03-08T02:30'], '02:30 does not exist; runs at 03:30 EDT');
  const after = nextOccurrence(schedule, gap.at);
  assert.deepEqual([iso(after.at), after.slot], ['2026-03-09T06:30:00.000Z', '2026-03-09T02:30']);
  assert.equal(iso(zonedInstant(2026, 3, 29, 1, 30, 'Europe/London')), '2026-03-29T01:30:00.000Z', 'London gap: 01:30 GMT runs as 02:30 BST');
});

test('a time repeated by the fall-back fold runs once, at its first occurrence', () => {
  const schedule = validateSchedule({ kind: 'daily', at: '01:30', timeZone: 'America/New_York' });
  const first = nextOccurrence(schedule, utc('2026-10-31T12:00:00Z'));
  assert.deepEqual([iso(first.at), first.slot], ['2026-11-01T05:30:00.000Z', '2026-11-01T01:30'], 'EDT occurrence');
  const next = nextOccurrence(schedule, first.at);
  assert.deepEqual([iso(next.at), next.slot], ['2026-11-02T06:30:00.000Z', '2026-11-02T01:30'], 'the repeated 01:30 EST is not a second run');
  const across = dueOccurrences(schedule, utc('2026-10-31T12:00:00Z'), utc('2026-11-01T12:00:00Z'));
  assert.equal(across.count, 1, 'a window spanning the fold counts one occurrence');
});

test('weekly schedules pick local weekdays; intervals are anchored', () => {
  const weekly = validateSchedule({ kind: 'weekly', days: [5, 1], at: '09:00', timeZone: 'America/Sao_Paulo' });
  assert.deepEqual(weekly.kind === 'weekly' && weekly.days, [1, 5], 'days are normalized');
  const friday = nextOccurrence(weekly, utc('2026-10-28T15:00:00Z'));
  assert.deepEqual([iso(friday.at), friday.slot], ['2026-10-30T12:00:00.000Z', '2026-10-30T09:00'], 'Wednesday -> Friday');
  assert.equal(nextOccurrence(weekly, friday.at).slot, '2026-11-02T09:00');
  const interval = validateSchedule({ kind: 'interval', minutes: 90, anchor: utc('2026-10-28T00:00:00Z') });
  assert.equal(iso(nextOccurrence(interval, utc('2026-10-28T02:00:00Z')).at), '2026-10-28T03:00:00.000Z');
  assert.equal(iso(nextOccurrence(interval, utc('2026-10-27T00:00:00Z')).at), '2026-10-28T00:00:00.000Z');
});

test('due occurrences count missed slots and keep the newest exact even when capped', () => {
  const schedule = validateSchedule({ kind: 'daily', at: '09:00', timeZone: 'UTC' });
  const due = dueOccurrences(schedule, utc('2026-10-01T10:00:00Z'), utc('2026-10-06T10:00:00Z'));
  assert.deepEqual([due.count, due.capped, due.latest?.slot], [5, false, '2026-10-06T09:00']);
  const capped = dueOccurrences(schedule, utc('2020-01-01T00:00:00Z'), utc('2026-10-06T10:00:00Z'), 10);
  assert.deepEqual([capped.count, capped.capped, capped.latest?.slot], [10, true, '2026-10-06T09:00']);
  const interval = validateSchedule({ kind: 'interval', minutes: 1, anchor: 0 });
  const many = dueOccurrences(interval, utc('2026-10-06T00:00:00Z'), utc('2026-10-06T10:00:30Z'), 5);
  assert.deepEqual([many.capped, many.latest && iso(many.latest.at)], [true, '2026-10-06T10:00:00.000Z']);
  assert.equal(dueOccurrences(schedule, utc('2026-10-06T10:00:00Z'), utc('2026-10-06T11:00:00Z')).latest, null);
});

test('schedules the scheduler cannot honour exactly are refused', () => {
  for (const bad of [
    null, {}, { kind: 'daily', at: '24:00', timeZone: 'UTC' }, { kind: 'daily', at: '9:00', timeZone: 'UTC' },
    { kind: 'daily', at: '09:00', timeZone: 'Mars/Olympus' }, { kind: 'weekly', days: [], at: '09:00', timeZone: 'UTC' },
    { kind: 'weekly', days: [7], at: '09:00', timeZone: 'UTC' }, { kind: 'weekly', days: [1, 1], at: '09:00', timeZone: 'UTC' },
    { kind: 'interval', minutes: 0, anchor: 0 }, { kind: 'interval', minutes: 1.5, anchor: 0 }, { kind: 'cron', expr: '* * * * *' },
  ]) assert.throws(() => validateSchedule(bad), /invalid_schedule/u, JSON.stringify(bad));
});
