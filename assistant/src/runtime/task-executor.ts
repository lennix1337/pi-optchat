import { randomUUID } from 'node:crypto';
import type { Event } from '../contracts/events.ts';
import type { Task } from '../contracts/tasks.ts';
import { TaskStore } from '../store/db.ts';
import { WorkerRuntime, type Job } from './worker.ts';
import { ToolTask } from './tool-task.ts';
import type { EffectRequest } from '../policy/gateway.ts';

export type DraftInput = { title: string; response: string | null };
/** `options`: up to four short answers the operator may pick for this one question, instead of typing. */
export type DraftResult = { kind: 'input' | 'draft'; text: string; options?: string[] };
/** The question a waiting task asks now; its options answer only this task revision and input request. */
export type TaskPrompt = { question: string; options: string[] };
/** No account could serve this generation now; the executor tries again on the next usable account. */
export const WAIT = { kind: 'wait' } as const;
export type PreviewPlan = { kind: 'browser_text'; text: string };
export type DraftRunner = (input: DraftInput, signal: AbortSignal) => Promise<DraftResult | PreviewPlan | typeof WAIT>;
export function parsePreview(value: unknown): PreviewPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_preview');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'kind,text' || v.kind !== 'browser_text' || typeof v.text !== 'string' || !v.text.isWellFormed() || Buffer.byteLength(v.text) > 1000) throw new Error('invalid_preview');
  return v as PreviewPlan;
}
export function parseDraftResult(value: unknown): DraftResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_draft');
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (!(keys === 'kind,text' || keys === 'kind,options,text' && v.kind === 'input' && validOptions(v.options)) || !['input', 'draft'].includes(String(v.kind)) ||
      typeof v.text !== 'string' || !v.text.trim() || !v.text.isWellFormed() || v.text.length > 4000) throw new Error('invalid_draft');
  return v as DraftResult;
}
function validOptions(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 2 && value.length <= 4 && new Set(value).size === value.length &&
    value.every(option => typeof option === 'string' && option === option.trim() && option.length > 0 && option.length <= 80 && option.isWellFormed() && !/[\r\n]/.test(option));
}

const LEASE_MS = 45_000;
/** Account switches per task revision before the task fails visibly, like the rotation's bounded recovery. */
export const MAX_ROUTE_ATTEMPTS = 12;
const isWait = (job: Job | undefined) => job?.state === 'done' && (job.result as { kind?: unknown } | null)?.kind === 'wait';
class PassFailure { readonly cause: unknown; constructor(cause: unknown) { this.cause = cause; } }
/** `failing` while the last pass threw; the executor keeps retrying each second and recovers on its own. */
export type ExecutorStatus = { state: 'idle' | 'running' | 'stopped'; failing: boolean; lastError?: string; lastErrorAt?: string };
export type ExecutorOptions = { store: TaskStore; profileId: string; databasePath: string; channels: string[]; run: DraftRunner;
  /** False while no account can serve a generation; admitted tasks then wait without a job. */
  ready?: () => Promise<boolean>;
  /** Also admits tasks this source vouches for (the operator's activated routines); human-created ones always qualify. */
  admit?: (origin: Event) => boolean; now?: () => number;
  tools?: { task: ToolTask; request: (task: Task, text: string, operationId: string) => EffectRequest } };

/** Only this opt-in channel's human-created (or operator-routine) drafts; no tools, sends or native approvals. */
export class TaskExecutor {
  private readonly runtime: WorkerRuntime;
  private cursor: string | null = null;
  private owned = false;
  private ticking: Promise<void> | undefined;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private failing = false;
  private lastError: { message: string; at: string } | undefined;
  private readonly options: ExecutorOptions;
  constructor(options: ExecutorOptions) {
    this.options = options;
    if (!options.store.matchesProfile(options.profileId) || !options.channels.length || options.channels.some(channel => !channel.trim())) throw new Error('executor_profile_or_channel');
    if (options.tools && (!options.store.matchesDatabase(options.databasePath) || options.tools.task.store !== options.store)) throw new Error('tool_database_mismatch');
    // One attempt: a generation interrupted by a crash may already have used the provider, so recovery fails it visibly.
    // The lease outlives one generation (30 s timeout); a crashed owner's lease expires and the next one recovers.
    this.runtime = new WorkerRuntime({ databasePath: options.databasePath, owner: randomUUID(), leaseMs: LEASE_MS, maxAttempts: 1, maxConcurrent: 1, ...(options.now ? { now: options.now } : {}),
      handlers: { draft: async (input, context) => {
        const result = await options.run(input as DraftInput, context.signal);
        if (result.kind === 'wait') return WAIT;
        return result.kind === 'browser_text' && options.tools ? parsePreview(result) : parseDraftResult(result);
      } } });
  }
  /** False while another owner (or a crashed one's unexpired lease) holds the jobs. */
  async acquire(): Promise<boolean> {
    if (this.owned) return true;
    if (!await this.runtime.acquire()) return false;
    // A clean stop requeues the generation it aborted; it may already have used the provider, so it is never resent.
    for (const job of this.runtime.jobs()) if (job.state === 'queued' && job.attempts > 0) this.runtime.cancel(job.id);
    return this.owned = true;
  }
  private id(task: Task, attempt = 0): string { return `draft:${task.taskId}:${task.revision}${attempt ? `:${attempt}` : ''}`; }
  /** The revision's current job, or the attempt number its next job takes after account waits. */
  private current(task: Task): { attempt: number; job?: Job } {
    let attempt = 0;
    for (let job = this.runtime.job(this.id(task)); job; job = this.runtime.job(this.id(task, ++attempt))) if (!isWait(job)) return { attempt, job };
    return { attempt };
  }
  private admitted(task: Task): boolean {
    const origin = this.options.store.creation(task.taskId)?.event;
    if (!origin || !this.options.channels.includes(origin.channelId)) return false;
    return (origin.source.sourceKind === 'trusted-local-human' ||
      origin.source.sourceKind === 'external' && origin.source.actorId === 'web-operator') || this.options.admit?.(origin) === true;
  }
  private event(task: Task, text: string): Event {
    const id = randomUUID();
    return { version: 1, eventId: id, correlationId: id, profileId: this.options.profileId, taskId: task.taskId,
      sessionId: 'draft-executor', channelId: this.options.store.creation(task.taskId)?.event.channelId ?? this.options.channels[0], runId: this.id(task),
      source: { actorId: 'draft-executor', sourceKind: 'worker', sourceEventId: id }, observedAt: new Date().toISOString(),
      sequence: this.options.store.nextSequence(), evidence: { kind: 'observed', reference: text } };
  }
  /** Serialized and paged; a done job is projected, never generated twice after a crash. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.ticking ??= this.pass().finally(() => { this.ticking = undefined; });
  }
  private async pass(): Promise<void> {
    if (!await this.acquire()) return;
    const page = this.options.store.list(this.cursor, 100); this.cursor = page.nextCursor;
    const pending: { task: Task; id: string }[] = [];
    let readiness: Promise<boolean> | undefined;
    // Account readiness concerns every task, so its failure fails the pass rather than this task.
    const ready = () => readiness ??= (this.options.ready?.() ?? Promise.resolve(true)).catch((cause: unknown) => { throw new PassFailure(cause); });
    for (const task of page.tasks) {
      if (!this.admitted(task) || !['queued', 'working'].includes(task.status)) continue;
      try {
        const prepared = await this.prepare(task, ready);
        if (prepared) pending.push(prepared);
      } catch (error) {
        if (error instanceof PassFailure) throw error.cause;
        if (error instanceof Error && error.message === 'lease_lost') throw error;
        this.unprepared(task.taskId);
      }
    }
    await this.runtime.runOnce();
    for (const { task, id } of pending) await this.project(task, id);
  }
  /** The operator may cancel or answer between reads; a stale revision skips this task, other failures propagate. */
  private stale(write: () => Task): Task | null {
    try { return write(); } catch (error) {
      if (error instanceof TypeError && /revision|transition/i.test(error.message)) return null;
      throw error;
    }
  }
  private transition(task: Task, next: Task['status'], note: string): Task {
    const event = this.event(task, note);
    return this.options.tools
      ? this.options.store.transitionWithLease(task.taskId, task.revision, next, event, this.runtime.leaseIdentity())
      : this.options.store.transition(task.taskId, task.revision, next, event);
  }
  /** The task's job for this pass, starting the task if it was queued; null when it waits or was changed meanwhile. */
  private async prepare(listed: Task, ready: () => Promise<boolean>): Promise<{ task: Task; id: string } | null> {
    let task = listed;
    let { attempt, job } = task.status === 'working' ? this.current(task) : { attempt: 0, job: undefined };
    if (!job) {
      // Restored from a backup: the original may already have generated this revision, so nothing is rebuilt for it.
      if (this.options.store.restoreHeld(task.taskId, task.revision)) return null;
      if (attempt >= MAX_ROUTE_ATTEMPTS) { this.stale(() => this.transition(task, 'failed', `Nenhuma conta conseguiu gerar após ${attempt} tentativas (limite, autenticação ou falha temporária). Tente novamente quando uma conta estiver disponível.`)); return null; }
      if (!await ready()) return null;
      if (task.status === 'queued') {
        const started = this.stale(() => this.transition(task, 'working', 'Preparando rascunho; nenhum efeito externo autorizado.'));
        if (!started) return null;
        task = started; attempt = 0;
      }
    }
    const id = job?.id ?? this.id(task, attempt);
    if (!job) this.runtime.enqueue(id, 'draft', { title: task.title, response: this.options.store.getResponse(task.taskId, task.inputRevision) });
    return { task, id };
  }
  /** One task that cannot be prepared fails on its own, before any generation, so it never blocks the others. */
  private unprepared(taskId: string): void {
    const task = this.options.store.get(taskId);
    if (!task || !['queued', 'working'].includes(task.status)) return;
    const working = task.status === 'queued' ? this.stale(() => this.transition(task, 'working', 'Preparando rascunho; nenhum efeito externo autorizado.')) : task;
    if (!working) return;
    this.stale(() => this.transition(working, 'failed', 'O executor não conseguiu preparar esta tarefa (erro interno). Nada foi gerado nem enviado; confira o serviço antes de tentar de novo.'));
  }
  /** The question this waiting task asks at its current revision; null once it was answered, cancelled or never asked here. */
  prompt(task: Task): TaskPrompt | null {
    if (task.status !== 'needs_input' || task.revision < 2) return null;
    const { job } = this.current({ ...task, revision: task.revision - 1 });
    if (job?.state !== 'done') return null;
    const output = parseDraftResult(job.result);
    return output.kind === 'input' ? { question: output.text, options: output.options ?? [] } : null;
  }
  /** Read-only unresolved dispatches; a live original dispatcher may still record its receipt. */
  unresolvedDispatches(): { taskId: string; revision: number; effectId: string }[] {
    return this.options.tools?.task.effects.pending().filter(item => item.state === 'dispatching')
      .map(item => ({ taskId: item.taskId, revision: item.revision, effectId: item.id })) ?? [];
  }
  status(): ExecutorStatus {
    return { state: this.stopped ? 'stopped' : this.timer ? 'running' : 'idle', failing: this.failing,
      ...(this.lastError ? { lastError: this.lastError.message, lastErrorAt: this.lastError.at } : {}) };
  }
  private async project(task: Task, id: string): Promise<void> {
    const job = this.runtime.job(id);
    if (!job || isWait(job) || !['done', 'failed', 'cancelled'].includes(job.state)) return;
    if (job.state === 'done' && (job.result as { kind?: unknown } | null)?.kind === 'browser_text' && this.options.tools) {
      const plan = parsePreview(job.result);
      const effectId = `tool:${task.taskId}:${task.revision}`;
      const prior = this.options.tools.task.effects.find(effectId);
      let effect = prior ?? this.options.tools.task.prepare(this.options.tools.request(task, plan.text, effectId), task.revision, effectId);
      if (effect.state === 'preparing') effect = this.options.tools.task.effects.reprepare(effectId);
      if (effect.state === 'waiting' || effect.state === 'done') effect = await this.options.tools.task.resume(effectId, this.runtime.leaseIdentity());
      if (effect.state === 'cancelled') {
        this.stale(() => this.options.store.transitionWithLease(task.taskId, task.revision, 'failed', this.event(task, 'Prévia negada, revogada ou expirou sem revisão; nada foi executado. Recoloque na fila para tentar de novo.'), this.runtime.leaseIdentity()));
      } else if (effect.state === 'uncertain' || effect.state === 'failed') {
        this.stale(() => this.options.store.transitionWithLease(task.taskId, task.revision, 'failed', this.event(task, 'Prévia bloqueada ou com resultado incerto; não será repetida automaticamente. Confira antes de tentar novamente.'), this.runtime.leaseIdentity()));
      }
      return;
    }
    const output = job.state === 'done' ? parseDraftResult(job.result) : null;
    const next = !output ? 'failed' : output.kind === 'input' ? 'needs_input' : 'ready_for_review';
    const note = !output ? 'Geração interrompida ou falhou. Pode ter havido consumo do provedor; não houve repetição automática. Confira antes de tentar novamente.'
      : `${output.kind === 'draft' ? 'Rascunho gerado, não verificado e não enviado' : 'Pergunta do executor'}:\n${output.text}`;
    this.stale(() => this.transition(task, next, note));
  }
  /** A failing pass never stops the executor: it is reported once per run of failures and retried next second. */
  start(onError: (error: Error) => void): void {
    if (this.timer || this.stopped) throw new Error('executor_not_startable');
    this.timer = setInterval(() => {
      void this.tick().then(() => { this.failing = false; }, (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.lastError = { message: error.message, at: new Date().toISOString() };
        if (!this.failing) onError(error);
        this.failing = true;
      });
    }, 1000);
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer);
    await this.runtime.stop();
    // A failed pass already rejected to whoever ran it; closing only waits for it to settle.
    await Promise.allSettled([this.ticking]);
    this.runtime.close();
  }
}
