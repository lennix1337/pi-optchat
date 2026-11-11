/** A report sent this recently and not yet logged may still be on its way through Pi's queue. */
export const REPORT_IN_FLIGHT_MS = 2 * 60_000;

export interface PendingReport { text: string; sentAt?: number; awaitingProcessing?: boolean; workerRecovery?: boolean }

const firstLine = (text: string, max = 80) => {
  const line = text.split('\n', 1)[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The first lines of the reports, so a refusal says which ones it waits for. */
export function describeReports(reports: readonly PendingReport[], limit = 5): string {
  const shown = reports.slice(0, limit).map(r => `"${firstLine(r.text)}"`);
  const more = reports.length - shown.length;
  return more > 0 ? `${shown.join('; ')}; +${more} more` : shown.join('; ');
}

/**
 * Why pending reports hold a reload, or undefined when they do not. Every report stays journaled in pending-reports.json and
 * startup sends again the ones memory has not logged, so a reload loses none. Only a report sent moments ago (still in Pi's
 * queue) or one a wake is waiting on holds it; a report held for quota or long unlogged is redelivered after the reload.
 */
export function reportsBlockReload(reports: readonly PendingReport[], now: number, held: (report: PendingReport) => boolean): string | undefined {
  const blocking = reports.filter(r => !held(r) &&
    (r.awaitingProcessing || r.workerRecovery || r.sentAt !== undefined && now - r.sentAt < REPORT_IN_FLIGHT_MS));
  if (!blocking.length) return undefined;
  const waiting = reports.length - blocking.length;
  return `${blocking.length} report(s) still being delivered: ${describeReports(blocking)}.`
    + (waiting ? ` ${waiting} other journaled report(s) are redelivered after the reload.` : '')
    + ' Retry once they reach the chat.';
}
