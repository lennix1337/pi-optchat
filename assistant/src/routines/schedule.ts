/**
 * Wall-clock schedules in an IANA time zone. Local times follow the Temporal
 * "compatible" rule: a time skipped by a DST gap runs one gap later, and a time
 * repeated by a DST fold runs once, at its first occurrence. Each occurrence has
 * a stable slot key (local date and time, or the instant for intervals), so a
 * repeated or rewound clock maps to the same slot instead of a new run.
 */
export type Schedule =
  | { kind: 'daily'; at: string; timeZone: string }
  | { kind: 'weekly'; days: readonly number[]; at: string; timeZone: string }
  | { kind: 'interval'; minutes: number; anchor: number };
export type Occurrence = { at: number; slot: string };

const MINUTE = 60_000;
const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    formatters.set(timeZone, value);
  }
  return value;
}

type Local = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock fields of an instant in an IANA zone; throws RangeError for an unknown zone. */
export function local(instant: number, timeZone: string): Local & { second: number } {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) parts[part.type] = part.value;
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second, weekday: weekdays.indexOf(parts.weekday) };
}
function offset(instant: number, timeZone: string): number {
  const t = Math.floor(instant / 1000) * 1000;
  const l = local(t, timeZone);
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - t;
}

/** The instant of a local wall time; compatible disambiguation (see module comment). */
export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offset(wall - DAY / 2, timeZone);
  const after = offset(wall + DAY / 2, timeZone);
  const matches = [wall - before, wall - after].filter(t => {
    const l = local(t, timeZone);
    return l.year === year && l.month === month && l.day === day && l.hour === hour && l.minute === minute;
  });
  return matches.length ? Math.min(...matches) : wall - before;
}

function parseAt(at: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(at);
  if (!match) throw new Error('invalid_schedule');
  return { hour: +match[1], minute: +match[2] };
}
const pad = (n: number) => String(n).padStart(2, '0');

function check(condition: boolean): void { if (!condition) throw new Error('invalid_schedule'); }
const isInt = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

function validateWallClock(input: Record<string, unknown>): { at: string; timeZone: string } {
  check(typeof input.at === 'string' && typeof input.timeZone === 'string');
  const { at, timeZone } = input as { at: string; timeZone: string };
  parseAt(at);
  try { formatter(timeZone); } catch { throw new Error('invalid_schedule'); }
  return { at, timeZone };
}

/** Throws `invalid_schedule` for anything the scheduler cannot honour exactly. Returns a normalized copy. */
export function validateSchedule(value: unknown): Schedule {
  const input = value as Record<string, unknown> | null;
  check(!!input && typeof input === 'object');
  switch (input!.kind) {
    case 'interval': {
      const { minutes, anchor } = input!;
      check(isInt(minutes, 1, 366 * 24 * 60) && isInt(anchor, 0, Number.MAX_SAFE_INTEGER));
      return { kind: 'interval', minutes: minutes as number, anchor: anchor as number };
    }
    case 'daily': return { kind: 'daily', ...validateWallClock(input!) };
    case 'weekly': {
      const days = input!.days;
      check(Array.isArray(days) && days.length > 0 && days.every(d => isInt(d, 0, 6)) && new Set(days).size === days.length);
      return { kind: 'weekly', days: [...(days as number[])].sort(), ...validateWallClock(input!) };
    }
    default: throw new Error('invalid_schedule');
  }
}

/** The first occurrence strictly after `after`. */
export function nextOccurrence(schedule: Schedule, after: number): Occurrence {
  if (schedule.kind === 'interval') {
    const step = schedule.minutes * MINUTE;
    const k = after < schedule.anchor ? 0 : Math.floor((after - schedule.anchor) / step) + 1;
    const at = schedule.anchor + k * step;
    return { at, slot: new Date(at).toISOString() };
  }
  const { hour, minute } = parseAt(schedule.at);
  const start = local(after, schedule.timeZone);
  // Walk local calendar days; noon UTC of each date avoids crossing dates at DST edges.
  for (let i = 0; i <= 8; i++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i, 12));
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (schedule.kind === 'weekly' && !schedule.days.includes(date.getUTCDay())) continue;
    const at = zonedInstant(y, m, d, hour, minute, schedule.timeZone);
    if (at > after) return { at, slot: `${y}-${pad(m)}-${pad(d)}T${schedule.at}` };
  }
  throw new Error('invalid_schedule');
}

/** Occurrences in (from, to], counted up to `cap`; the last one is the newest due slot. */
export function dueOccurrences(schedule: Schedule, from: number, to: number, cap = 1000): { count: number; capped: boolean; latest: Occurrence | null } {
  let count = 0; let latest: Occurrence | null = null; let cursor = from;
  while (count < cap) {
    const next = nextOccurrence(schedule, cursor);
    if (next.at > to) return { count, capped: false, latest };
    count++; latest = next; cursor = next.at;
  }
  // Too many to walk: the newest slot is still exact, the count is a floor.
  if (schedule.kind === 'interval') {
    const step = schedule.minutes * MINUTE;
    const at = schedule.anchor + Math.floor((to - schedule.anchor) / step) * step;
    latest = { at, slot: new Date(at).toISOString() };
  } else {
    let probe = nextOccurrence(schedule, to - 8 * DAY);
    for (let next = probe; next.at <= to; next = nextOccurrence(schedule, next.at)) probe = next;
    latest = probe;
  }
  return { count, capped: true, latest };
}
