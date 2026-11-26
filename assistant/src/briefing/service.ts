import { localDateTime } from '../connectors/google.ts';
import type { GoogleLocal } from '../connectors/google-local.ts';
import { singleFlight } from '../single-flight.ts';
import type { Briefing, BriefingComposer } from './compose.ts';
import type { MeetingPrepCard } from './meeting-prep.ts';

const MEETING_LEAD_MS = 30 * 60_000;

/**
 * The background side of the Google briefing: once the profile's local time reaches `dailyAt`, today's briefing is read
 * (once per local date, kept across restarts by the composer) and announced; `refresh` reads now for a client that
 * asks. Concurrent callers of either share the read in flight. Mail stays untrusted data and nothing is started here.
 */
export type BriefingServiceOptions = {
  local: Pick<GoogleLocal, 'withComposer'>;
  connections: string[]; timeZone: string;
  /** Local HH:MM after which today's briefing is read. */
  dailyAt: string;
  now?: () => number;
  /** Called with each daily briefing the service reads or finds stored; must not throw. */
  onReady?: (briefing: Briefing) => void;
  meetingPrep?: boolean;
  onMeetingPrep?: (card: MeetingPrepCard) => void | Promise<void>;
};

export class BriefingService {
  private readonly options: BriefingServiceOptions;
  private readonly now: () => number;
  private doneDate: string | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: BriefingServiceOptions) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(options.dailyAt)) throw new Error('invalid_options');
    this.options = { ...options, connections: [...options.connections] };
    this.now = options.now ?? Date.now;
  }

  /** Reads today's briefing when it is due and not yet read by this process; otherwise null. */
  readonly tick: () => Promise<Briefing | null> = singleFlight(async () => {
    const now = this.now();
    const { date, time } = localDateTime(now, this.options.timeZone);
    const { dailyAt, meetingPrep, onMeetingPrep, onReady } = this.options;
    const due = time >= dailyAt && this.doneDate !== date;
    const notify = meetingPrep ? onMeetingPrep : undefined;
    if (!due && !notify) return null;

    return this.compose(async composer => {
      const daily = due ? await composer.readDaily(now) : null;
      if (daily) {
        this.doneDate = date;
        onReady?.(daily.briefing);
      }
      if (notify) await this.meetingReminders(composer, now, daily?.fresh ?? null, notify);
      return daily?.briefing ?? null;
    });
  });

  /** A briefing read now (on demand). */
  readonly refresh: () => Promise<Briefing> = singleFlight(() => this.compose(composer => composer.onDemand()));

  /** The newest stored briefing; reads nothing from Google. */
  latest(): Promise<Briefing | null> { return this.compose(composer => composer.latest()); }

  start(intervalMs: number, onError: (error: unknown) => void): void {
    this.stop();
    const run = () => { this.tick().catch(onError); };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  private compose<T>(use: (composer: BriefingComposer) => T | Promise<T>): Promise<T> {
    return this.options.local.withComposer(this.options.connections, this.options.timeZone, use, this.options.meetingPrep === true);
  }

  private async meetingReminders(composer: BriefingComposer, now: number, fresh: Briefing | null, notify: NonNullable<BriefingServiceOptions['onMeetingPrep']>): Promise<void> {
    const { cards, sources } = await composer.upcomingMeetingPrep(now, MEETING_LEAD_MS, fresh);
    const errors: unknown[] = [];
    const attempted = new Set<string>();
    for (const card of cards) {
      const { cardId } = card;
      const start = Date.parse(card.start);
      if (start <= this.now() || attempted.has(cardId)) continue;
      attempted.add(cardId);
      try {
        await notify(card);
        composer.recordMeetingPrep(cardId, start);
      } catch (error) { errors.push(error); }
    }
    const unavailable = sources.find(source => source.state === 'unavailable');
    if (unavailable) errors.push(new Error(unavailable.error ?? 'source_failed'));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'meeting_prep_failed');
  }
}
