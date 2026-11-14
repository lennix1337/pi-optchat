/**
 * The line of a `crew` accept answer that names the pull request it opened. crew-accept.ts writes it with `prLine`; what
 * a wake records as delivered (heartbeat-report.ts, wake-log.ts) reads it back with `acceptedPr`, so the two cannot drift.
 * It stands apart from both with no imports: crew-accept.ts imports crew.ts, which imports wake-log.ts, so a reader that
 * imported the writer would close a cycle.
 */
const LABEL = 'PR: ';
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)$/;

/** The answer's second line, right under its head. `pr` is the PR's URL, or what stands in for it when ship reported none. */
export const prLine = (pr: string) => `${LABEL}${pr}`;

export interface AcceptedPr { url: string; repo: string; number: string }

/**
 * The PR an accept opened, read from its answer. Undefined for every other text: a refusal and an uncertain ship never
 * write the line, and a PR without a URL cannot be named. Only the second line counts: the lines after it quote free text
 * (commitments, the worker's memory proposal) that may hold a line of the same shape.
 */
export function acceptedPr(answer: string): AcceptedPr | undefined {
  const line = answer.split(/\r?\n/, 2)[1] ?? '';
  const found = line.startsWith(LABEL) ? PR_URL.exec(line.slice(LABEL.length)) : null;
  return found ? { url: found[0], repo: found[1]!, number: found[2]! } : undefined;
}
