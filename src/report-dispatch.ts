/** How long a report sent to an idle Pi may take to start its turn before the send counts as lost. */
export const REPORT_START_WAIT_MS = 15_000;
/** Reports that arrive while a turn runs wait this long for company before they steer into it as one message. */
export const REPORT_GATHER_MS = 1_500;
/** Starts of one report tried before it is left journaled for the next startup. */
export const REPORT_START_ATTEMPTS = 3;

export interface ReportDispatchHost<R> {
  /** Hands one report to Pi. `fromIdle`: no turn is running, so this send has to start one. */
  send: (report: R, fromIdle: boolean) => void;
  idle: () => boolean;
  /** A send from idle that never started a turn. `giveUp`: attempts are spent, the report stays journaled. */
  failed: (report: R, attempt: number, giveUp: boolean) => void;
  /** Packs the reports waiting into the messages that carry them, in order (a bundle may stand for several). Without it each report goes alone. */
  pack?: (waiting: R[]) => R[];
  /** With `pack`: reports that arrive while a turn runs wait this long for company, then go out together. A send from idle never waits. */
  gatherMs?: number;
  startWaitMs?: number;
  pollMs?: number;
  attempts?: number;
}

/**
 * Sends reports to Pi one start at a time.
 *
 * Pi starts a turn from a message asynchronously, and `pi.sendMessage` / `pi.sendUserMessage` return nothing: a second send made
 * before the first turn is running tries to start a turn of its own, Pi refuses it ("Agent is already processing a prompt") and
 * the report is gone. So a send from idle waits until its turn is running (every later send then queues into it as a steer), or
 * until the wait ends, when it is retried or, after the last attempt, reported through `failed` and left to the journal.
 */
export class ReportDispatcher<R> {
  private queue: { report: R; attempt: number }[] = [];
  private starting: { report: R; attempt: number; deadline: number } | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private gather: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly host: ReportDispatchHost<R>) {}

  push(report: R) { this.pushAll([report]); }

  /** Several reports at once: they are packed together, so a burst leaves as few messages as the pack allows. */
  pushAll(reports: R[]) {
    if (this.closed || !reports.length) return;
    for (const report of reports) this.queue.push({ report, attempt: 1 });
    this.pump();
  }

  /** Pi began a turn (its `agent_start`): what waits can steer into it, packed, with nothing more to wait for. */
  started() {
    if (this.starting) this.settle();
    this.pump(true);
  }

  /** Profile closed: nothing waits for a turn any more. */
  close() {
    this.closed = true; this.queue = []; this.starting = undefined; this.endPoll(); this.endGather();
  }

  /** The profile opened again. */
  open() { this.closed = false; }

  private pump(now = false) {
    if (!now && this.gathering()) return;
    this.pack();
    while (!this.closed && this.queue.length && !this.starting) {
      const next = this.queue.shift()!;
      const fromIdle = this.host.idle();
      this.host.send(next.report, fromIdle);
      if (!fromIdle) continue;
      this.starting = { ...next, deadline: Date.now() + (this.host.startWaitMs ?? REPORT_START_WAIT_MS) };
      this.poll ??= setInterval(() => this.check(), this.host.pollMs ?? 25);
      this.poll.unref();
    }
    if (!this.starting) this.endPoll();
  }

  private settle() { this.starting = undefined; }

  /** A report arriving while a turn runs waits briefly for others: they steer into the turn as one message. */
  private gathering() {
    const wait = this.host.gatherMs ?? 0;
    if (!wait || !this.host.pack || this.starting || !this.queue.length || this.host.idle()) return false;
    this.gather ??= setTimeout(() => { this.gather = undefined; this.pump(true); }, wait);
    this.gather.unref?.();
    return true;
  }

  /** What is waiting for its first try becomes the packed messages; a message already tried stays as it was. */
  private pack() {
    this.endGather();
    if (!this.host.pack || this.queue.length < 2) return;
    const tried = this.queue.filter(entry => entry.attempt > 1), fresh = this.queue.filter(entry => entry.attempt === 1);
    this.queue = [...tried, ...this.host.pack(fresh.map(entry => entry.report)).map(report => ({ report, attempt: 1 }))];
  }

  private check() {
    const starting = this.starting;
    if (!starting) { this.endPoll(); return; }
    if (!this.host.idle()) { this.started(); return; }
    if (Date.now() < starting.deadline) return;
    this.settle();
    const giveUp = starting.attempt >= (this.host.attempts ?? REPORT_START_ATTEMPTS);
    this.host.failed(starting.report, starting.attempt, giveUp);
    if (!giveUp) this.queue.unshift({ report: starting.report, attempt: starting.attempt + 1 });
    this.pump();
  }

  private endPoll() {
    clearInterval(this.poll);
    this.poll = undefined;
  }

  private endGather() {
    clearTimeout(this.gather);
    this.gather = undefined;
  }
}
