import { localDateTime } from '../connectors/google.ts';
import type { GoogleLocal } from '../connectors/google-local.ts';
import { singleFlight } from '../single-flight.ts';
import type { Briefing, BriefingComposer } from './compose.ts';
import { CLOCK, type WeeklySchedule } from './weekly.ts';

/**
 * The background side of the Google briefing: once the profile's local time reaches `dailyAt`, today's briefing is read
 * (once per local date, kept across restarts by the composer) and announced; `refresh` reads now for a client that
 * asks. Concurrent callers of either share the read in flight. Mail stays untrusted data and nothing is started here.
 * With `weekly` set, one weekly review is read on that local weekday once the local time reaches its hour, and announced
 * once per week (a restart the same evening finds it stored and says nothing). A week the service missed is read on the
 * next tick, until the next boundary, once the feature has produced a review before. A review with an unavailable source is
 * not stored: the tick fails with `weekly_review_incomplete` and retries every 15 minutes, a delay a restart keeps, and
 * after three tries a review missing some sources is saved with them listed as unavailable (never when all are down). Without `weekly` nothing is read for it.
 */
export type BriefingServiceOptions = {
  local: Pick<GoogleLocal, 'withComposer'>;
  connections: string[]; timeZone: string;
  /** Local HH:MM after which today's briefing is read. */
  dailyAt: string;
  now?: () => number;
  /** Opt-in weekly review: local weekday (0 = Sunday) and HH:MM after which it is read that day. */
  weekly?: WeeklySchedule;
  /** Called once with each weekly review this service creates; must not throw. */
  onWeekly?: (briefing: Briefing) => void;
  /** Called with each daily briefing the service reads or finds stored; must not throw. */
  onReady?: (briefing: Briefing) => void;
};

const WEEKLY_RETRY_MS = 15 * 60_000;

export class BriefingService {
  private readonly options: BriefingServiceOptions;
  private readonly now: () => number;
  private doneDate: string | null = null;
  private weeklyDate: string | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: BriefingServiceOptions) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(options.dailyAt) || (options.weekly && !(Number.isInteger(options.weekly.day) && options.weekly.day >= 0 && options.weekly.day <= 6 && CLOCK.test(options.weekly.at)))) throw new Error('invalid_options');
    this.options = { ...options, connections: [...options.connections] };
    this.now = options.now ?? Date.now;
  }

  /** Reads today's briefing when it is due and not yet read by this process; otherwise null. */
  readonly tick: () => Promise<Briefing | null> = singleFlight(() => this.due());

  /** Reads this week's review when it is due and not yet sent; otherwise null. Never due without the `weekly` option. */
  readonly weeklyTick: () => Promise<Briefing | null> = singleFlight(() => this.weeklyDue());

  /** A briefing read now (on demand). */
  readonly refresh: () => Promise<Briefing> = singleFlight(() => this.compose(composer => composer.onDemand()));

  /** The newest stored briefing; reads nothing from Google. */
  latest(): Promise<Briefing | null> { return this.compose(composer => composer.latest()); }

  /** The newest stored weekly review; reads nothing from Google. */
  latestWeekly(): Promise<Briefing | null> { return this.compose(composer => composer.latestWeekly()); }

  start(intervalMs: number, onError: (error: unknown) => void): void {
    this.stop();
    const run = () => { this.tick().catch(onError); this.weeklyTick().catch(onError); };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  private compose<T>(use: (composer: BriefingComposer) => T | Promise<T>): Promise<T> {
    return this.options.local.withComposer(this.options.connections, this.options.timeZone, use);
  }

  private async due(): Promise<Briefing | null> {
    const { date, time } = localDateTime(this.now(), this.options.timeZone);
    if (time < this.options.dailyAt || this.doneDate === date) return null;
    const briefing = await this.compose(composer => composer.daily());
    this.doneDate = date;
    this.options.onReady?.(briefing);
    return briefing;
  }

  private async weeklyDue(): Promise<Briefing | null> {
    const schedule = this.options.weekly;
    if (!schedule) return null;
    const { date, time } = localDateTime(this.now(), this.options.timeZone);
    const [year, month, day] = date.split('-').map(Number);
    const daysSince = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() - schedule.day + 7) % 7;
    const dueToday = daysSince === 0 && time >= schedule.at;
    const due = new Date(Date.UTC(year, month - 1, day - (daysSince === 0 && !dueToday ? 7 : daysSince))).toISOString().slice(0, 10);
    if (this.weeklyDate === due) return null;
    const result = await this.compose(composer => {
      if (!dueToday && !composer.latestWeekly()) return null;
      const attempt = composer.weeklyAttempt(due);
      return attempt && this.now() < attempt.at + WEEKLY_RETRY_MS ? null : composer.weekly(due);
    });
    if (!result) return null;
    const { briefing, created, complete, degraded } = result;
    if (!complete) throw new Error('weekly_review_incomplete');
    if (!degraded) this.weeklyDate = due;
    if (!created) return null;
    this.options.onWeekly?.(briefing);
    return briefing;
  }
}
