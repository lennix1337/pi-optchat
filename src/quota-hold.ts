import { brasiliaDayTime } from './pc-health.ts';

/** A model call that ended because the account is out of quota or rate-limited, not because the request was wrong. */
const QUOTA_ERROR = /\b429\b|rate[_ -]?limit|usage limit|quota|credit balance|resource[_ ]?exhausted|insufficient[_ ]credits?|too many requests/i;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/**
 * Whether an error message says "out of quota", and when the provider says it ends (`retryAt`, epoch ms) when the message
 * carries a hint ("Try again in ~1129 min", "retry-after: 30", "resets at 2025-11-10T22:20:00Z"). Anything else is a real failure.
 */
export function quotaError(message: string | undefined, now: number): { retryAt?: number } | undefined {
  if (!message || !QUOTA_ERROR.test(message)) return undefined;
  const relative = /try again in\s*~?\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|seconds?|secs?|hours?|hrs?|[smh])\b/i.exec(message);
  if (relative) return { retryAt: now + Number(relative[1]) * UNIT_MS[relative[2][0].toLowerCase()] };
  const after = /retry[- ]after[:= ]+\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|seconds?|secs?|hours?|hrs?|[smh])?\b/i.exec(message);
  if (after) return { retryAt: now + Number(after[1]) * UNIT_MS[(after[2]?.[0] ?? 's').toLowerCase()] };
  const absolute = /resets?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i.exec(message);
  const at = absolute ? Date.parse(absolute[1]) : NaN;
  return Number.isFinite(at) && at > now ? { retryAt: at } : {};
}

/** Pause after a quota error's stated reset, so the first request does not land on the boundary. */
export const PARK_MARGIN_MS = 60_000;
/** The manager's held items are released this long after the reset it was told. */
const OUTAGE_MARGIN_MS = 5000;
/** A worker is parked this many times at most before its quota error is reported as a failure. */
export const PARK_MAX = 6;
/** Waits used when neither the cached quota nor the error says when it comes back (minutes by attempt). */
const BACKOFF_MINUTES = [5, 15, 30, 60, 120, 240];

/** When a parked worker tries again: the latest known reset (cache or error hint) plus the margin, else a growing wait. */
export function parkUntil(now: number, attempt: number, ...resets: (number | undefined)[]) {
  const known = resets.filter((at): at is number => at !== undefined && at > now);
  return known.length ? Math.max(...known) + PARK_MARGIN_MS : now + BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)] * 60_000;
}

/** A moment in Brasília time: the clock alone when it is still today there, else with the day. */
export function untilText(at: number, now: number) {
  const stamp = brasiliaDayTime(at);
  return stamp.slice(0, 5) === brasiliaDayTime(now).slice(0, 5) ? stamp.slice(6) : `${stamp.slice(0, 5)} ${stamp.slice(6)}`;
}

/**
 * Holds what would start a manager turn while every model the manager could run on is out of quota. One notice per outage;
 * when the cached quota (or a retry hint learned from a failed turn) says the models are back, everything held is released at once.
 * A retry hint belongs to the provider whose turn failed: the host applies it to that provider's routes only, so a limit met
 * on an account the failover tried never keeps the manager's own account out after its quota returns.
 */
export interface OutageHost<T> {
  now(): number;
  /**
   * When the manager's models come back: the cached quota plus `learned` (retry hints still in the future, by provider id);
   * undefined when one of them is usable (or nothing is known).
   */
  until(learned: Readonly<Record<string, number>>): number | undefined;
  notice(text: string): void;
  send(items: T[]): void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
export class QuotaOutage<T> {
  private held: T[] = [];
  /** Retry hints from failed turns, by the provider that failed. */
  private learned: Record<string, number> = {};
  private lastError: string | undefined;
  private timer: unknown;
  private open = false;
  constructor(private readonly host: OutageHost<T>) {}
  private blockedUntil() {
    const now = this.host.now();
    this.learned = Object.fromEntries(Object.entries(this.learned).filter(([, at]) => at > now));
    const until = this.host.until(this.learned);
    return until !== undefined && until > now ? until : undefined;
  }
  /** True while the item is held: the caller must not start a turn for it. */
  offer(item: T) {
    const until = this.blockedUntil();
    if (until === undefined) return false;
    this.held.push(item);
    if (!this.open) {
      this.open = true;
      this.host.notice(`cota esgotada em todas as contas; volto às ${untilText(until, this.host.now())} (Brasília)`);
    }
    this.arm(until);
    return true;
  }
  /** A failed turn's error: when it is a quota error with a retry hint, that provider stays out until then. */
  note(error: string | undefined, provider: string) {
    const failure = `${provider}: ${error}`;
    if (!error || failure === this.lastError) return;
    this.lastError = failure;
    const retryAt = quotaError(error, this.host.now())?.retryAt;
    if (retryAt !== undefined) this.learned[provider] = Math.max(this.learned[provider] ?? 0, retryAt);
  }
  /** The manager's model changed: what was armed for the old one is judged again (released at once, or re-armed for the new one's time). */
  recheck() {
    if (!this.open) return;
    if (this.timer !== undefined) this.host.clearTimer(this.timer);
    this.release();
  }
  get holding() { return this.held.length; }
  holds(item: T) { return this.held.includes(item); }
  private arm(until: number) {
    if (this.timer !== undefined) this.host.clearTimer(this.timer);
    this.timer = this.host.setTimer(() => this.release(), Math.max(0, until - this.host.now()) + OUTAGE_MARGIN_MS);
  }
  private release() {
    this.timer = undefined;
    const until = this.blockedUntil();
    if (until !== undefined) { this.arm(until); return; } // Still out (a later reset than first said): the same outage, no new notice.
    this.open = false; this.lastError = undefined;
    const items = this.held.splice(0);
    if (items.length) this.host.send(items);
  }
  close() {
    if (this.timer !== undefined) this.host.clearTimer(this.timer);
    this.timer = undefined; this.held = []; this.open = false; this.learned = {}; this.lastError = undefined;
  }
}
