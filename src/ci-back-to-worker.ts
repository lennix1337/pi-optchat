/**
 * A PR a worker's branch was shipped as (`crew accept`) is followed by pi-gitwatch with the worker's run id as its
 * subscriber. A notice that needs action (red CI, conflict, review) goes back to that worker, which resumes with its
 * conversation and fixes its own PR; the manager only hears about it when the worker cannot take it.
 */
export const SUBSCRIBER_NOTICE_CHANNEL = 'gitwatch:subscriber-notice';

/** Resumes of one worker for one PR before the notice goes to the manager instead: a worker that keeps failing is the manager's to read. */
export const RESUME_LIMIT = 3;

export interface SubscriberClaim { subscriber: string; repo: string; wake: boolean; text: string; events?: { pr: number; kind: string; text: string; wake: boolean }[]; accepted: boolean; accept(): void }

export function formatWorkerCorrection(fields: { expected: string; seen: string; allowed: string; tried: string }): string {
  return `Esperado: ${fields.expected}\nVisto: ${fields.seen}\nÁrea permitida: ${fields.allowed}\nJá tentado/falhou: ${fields.tried}`;
}
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
  const previous = new Map<string, string[]>();
  return (claim: SubscriberClaim) => {
    const run = deps.info(claim.subscriber);
    if (!run || run.connected || !TAKES.has(run.state)) return;
    const key = `${claim.subscriber} ${claim.repo}`;
    if (claim.wake && (resumes.get(key) ?? 0) >= RESUME_LIMIT) return;
    claim.accept();
    if (!claim.wake) return;
    resumes.set(key, (resumes.get(key) ?? 0) + 1);
    const prs = [...new Set((claim.events ?? []).map(event => event.pr).filter(pr => pr > 0))];
    const historyKey = prs.length === 1 ? `${key} #${prs[0]}` : undefined;
    const earlier = historyKey ? previous.get(historyKey) ?? [] : [];
    const text = `[gitwatch] Your shipped PR needs you (${claim.repo}):\n${formatWorkerCorrection({
      expected: 'Corrigir o problema e deixar os checks do PR verdes.',
      seen: claim.text,
      allowed: prs.length === 1 ? `Os arquivos do PR #${prs[0]}; lista não incluída no aviso, consulte gh pr diff ${prs[0]} --repo ${claim.repo} --name-only antes de editar.` : 'Arquivos do PR; número ou lista não incluídos no aviso, confirme antes de editar.',
      tried: earlier.length ? `Avisos anteriores (não confirmam tentativas):\n${earlier.join('\n---\n')}` : 'Nenhum aviso anterior disponível nesta sessão.',
    })}\nFix it in your checkout, commit and push the same branch, then report. Do not loosen a test or a gate; if the cause is not yours, say so.`;
    void deps.notice(claim.subscriber, text).then(
      taken => {
        if (!taken) return deps.toManager(`[gitwatch] ${claim.subscriber} could not take this notice:\n${claim.text}`);
        if (historyKey) previous.set(historyKey, [...previous.get(historyKey) ?? [], claim.text]);
      },
      () => deps.toManager(`[gitwatch] ${claim.subscriber} could not take this notice:\n${claim.text}`));
  };
}
