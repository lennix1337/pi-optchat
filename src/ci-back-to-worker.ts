/**
 * A PR a worker's branch was shipped as (`crew accept`) is followed by pi-gitwatch with the worker's run id as its
 * subscriber. A notice that needs action (red CI, conflict, review) goes back to that worker, which resumes with its
 * conversation and fixes its own PR; the manager only hears about it when the worker cannot take it.
 */
export const SUBSCRIBER_NOTICE_CHANNEL = 'gitwatch:subscriber-notice';

/** Resumes of one worker for one PR before the notice goes to the manager instead: a worker that keeps failing is the manager's to read. */
export const RESUME_LIMIT = 3;

export interface SubscriberClaim { subscriber: string; repo: string; wake: boolean; text: string; accepted: boolean; accept(): void }
interface Run { state: string; connected?: boolean }
export interface CiBackDeps {
  info(id: string): Run | undefined;
  /** Puts the text into the worker's session (resuming a finished one); false when it cannot take it. */
  notice(id: string, text: string): Promise<boolean>;
  /** The manager's own route, used when the worker cannot take the notice. */
  toManager(text: string): Promise<unknown> | unknown;
}

const TAKES = new Set(['completed', 'failed', 'running', 'waiting', 'paused']);

export function ciBackToWorker(deps: CiBackDeps) {
  const resumes = new Map<string, number>();
  return (claim: SubscriberClaim) => {
    const run = deps.info(claim.subscriber);
    if (!run || run.connected || !TAKES.has(run.state)) return;
    const key = `${claim.subscriber} ${claim.repo}`;
    if (claim.wake && (resumes.get(key) ?? 0) >= RESUME_LIMIT) return;
    claim.accept();
    if (!claim.wake) return;
    resumes.set(key, (resumes.get(key) ?? 0) + 1);
    const text = `[gitwatch] Your shipped PR needs you (${claim.repo}):\n${claim.text}\nFix it in your checkout, commit and push the same branch, then report. Do not loosen a test or a gate; if the cause is not yours, say so.`;
    void deps.notice(claim.subscriber, text).then(
      taken => taken ? undefined : deps.toManager(`[gitwatch] ${claim.subscriber} could not take this notice:\n${claim.text}`),
      () => deps.toManager(`[gitwatch] ${claim.subscriber} could not take this notice:\n${claim.text}`));
  };
}
