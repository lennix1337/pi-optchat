import { localDateTime } from '../connectors/google.ts';
import type { GoogleLocal } from '../connectors/google-local.ts';
import { singleFlight } from '../single-flight.ts';
import type { Briefing, BriefingComposer } from './compose.ts';

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
  readonly tick: () => Promise<Briefing | null> = singleFlight(() => this.due());

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
}
