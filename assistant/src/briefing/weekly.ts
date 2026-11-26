/** The weekly review's configuration: opt-in, Sunday 18:00 unless the operator names another weekday or hour. */
export type WeeklySchedule = { day: number; at: string };
export type WeeklyConfig = true | { day?: string; at?: string };
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `true` or a partial `{ day, at }` from the configuration, with Sunday 18:00 filling what is missing; undefined stays off. */
export function weeklySchedule(config: WeeklyConfig | undefined): WeeklySchedule | undefined {
  if (!config) return undefined;
  const given = config === true ? {} : config;
  return { day: given.day === undefined ? 0 : WEEKDAYS.indexOf(given.day), at: given.at ?? '18:00' };
}

export function validWeekly(value: unknown): value is WeeklyConfig {
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { day, at, ...rest } = value as Record<string, unknown>;
  return Object.keys(rest).length === 0 && (day === undefined || (typeof day === 'string' && WEEKDAYS.includes(day))) && (at === undefined || (typeof at === 'string' && CLOCK.test(at)));
}
