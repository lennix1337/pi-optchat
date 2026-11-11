/** How long a report sent to an idle Pi may take to start its turn before the send counts as lost. */
export const REPORT_START_WAIT_MS = 15_000;
/** Starts of one report tried before it is left journaled for the next startup. */
export const REPORT_START_ATTEMPTS = 3;

export interface ReportDispatchHost<R> {
  /** Hands one report to Pi. `fromIdle`: no turn is running, so this send has to start one. */
  send: (report: R, fromIdle: boolean) => void;
  idle: () => boolean;
  /** A send from idle that never started a turn. `giveUp`: attempts are spent, the report stays journaled. */
  failed: (report: R, attempt: number, giveUp: boolean) => void;
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
  private closed = false;

  constructor(private readonly host: ReportDispatchHost<R>) {}

  push(report: R) {
    if (this.closed) return;
    this.queue.push({ report, attempt: 1 });
    this.pump();
  }

  /** Pi began a turn (its `agent_start`): what waits can steer into it. */
  started() {
    if (this.starting) this.settle();
    this.pump();
  }

  /** Profile closed: nothing waits for a turn any more. */
  close() {
    this.closed = true; this.queue = []; this.starting = undefined; this.endPoll();
  }

  /** The profile opened again. */
  open() { this.closed = false; }

  private pump() {
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
}
