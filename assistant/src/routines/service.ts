import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Event } from '../contracts/events.ts';
import { boundedText } from '../contracts/validation.ts';
import { WorkerRuntime } from '../runtime/worker.ts';
import type { TaskStore } from '../store/db.ts';
import { prepareDatabase } from '../store/privacy.ts';
import { createRoutines, type RoutineManager } from './manager.ts';

/** The only routine kind the service runs: each due slot becomes one queued task in a channel. */
export const TASK_KIND = 'task';
export type RoutineTask = { title: string; channelId: string };
type RunInput = { routineId: string; profileId: string; slot: string; missed: number; input: unknown };

const line = (max: number) => (value: unknown) => boundedText(max)(value) && !/[\x00-\x1f\x7f]/.test(value as string);
export function parseRoutineTask(value: unknown): RoutineTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_routine_task');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'channelId,title' || !line(200)(v.title) || !line(80)(v.channelId)) throw new Error('invalid_routine_task');
  return { title: v.title as string, channelId: v.channelId as string };
}

export const routinesDatabase = (tasksDatabase: string) => join(dirname(tasksDatabase), 'routines.sqlite');

/** The operator's view for the routine CLI: it manages routines but never takes the lease, so it runs nothing. */
export function openRoutineAdmin(tasksDatabase: string): { routines: RoutineManager; close(): void } {
  const databasePath = routinesDatabase(tasksDatabase);
  prepareDatabase(databasePath);
  const runtime = new WorkerRuntime({ databasePath, owner: `admin-${randomUUID()}`, handlers: { [TASK_KIND]: () => { throw new Error('admin_only'); } } });
  const routines = createRoutines({ databasePath, runtime });
  return { routines, close() { routines.close(); runtime.close(); } };
}

export type RoutineServiceOptions = { store: TaskStore; profileId: string; tasksDatabase: string; now?: () => number };

/**
 * Runs the operator's active routines inside the service. A due slot (see RoutineManager for missed slots and
 * clock skew) becomes exactly one queued task, whose id and source event derive from the slot, so a crash or
 * restart never creates it twice. The task then follows its channel: the draft executor takes it only when that
 * channel is one of the executor's; nothing else runs or is sent here.
 */
export class RoutineService {
  readonly routines: RoutineManager;
  private readonly runtime: WorkerRuntime;
  private readonly options: RoutineServiceOptions;
  private owned = false;
  private stopped = false;
  private failing = false;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;

  constructor(options: RoutineServiceOptions) {
    if (!options.store.matchesProfile(options.profileId)) throw new Error('routine_profile');
    this.options = options;
    const databasePath = routinesDatabase(options.tasksDatabase);
    prepareDatabase(databasePath);
    this.runtime = new WorkerRuntime({ databasePath, owner: randomUUID(), ...(options.now ? { now: options.now } : {}), handlers: { [TASK_KIND]: input => this.createTask(input as RunInput) } });
    this.routines = createRoutines({ databasePath, runtime: this.runtime, ...(options.now ? { now: options.now } : {}) });
  }

  private createTask(run: RunInput): { taskId: string } {
    const { store, profileId } = this.options;
    if (run.profileId !== profileId) throw new Error('routine_profile');
    const spec = parseRoutineTask(run.input);
    const slotId = `routine:${run.routineId}:${run.slot}`;
    const taskId = `routine-${createHash('sha256').update(slotId).digest('hex').slice(0, 32)}`;
    if (store.get(taskId)) return { taskId };
    const note = `Rotina ${run.routineId}, horário ${run.slot}${run.missed > 0 ? `; ${run.missed} horário(s) perdido(s) consolidado(s) nesta execução` : ''}.`;
    const event: Event = { version: 1, eventId: randomUUID(), correlationId: randomUUID(), profileId, taskId, sessionId: 'routines', channelId: spec.channelId, runId: slotId,
      source: { actorId: `routine:${run.routineId}`, sourceKind: 'worker', sourceEventId: slotId }, observedAt: new Date().toISOString(),
      sequence: store.nextSequence(), evidence: { kind: 'observed', reference: note } };
    store.create({ version: 1, profileId, taskId, title: spec.title, status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: slotId }, event);
    return { taskId };
  }

  /** True only for a task this service created from a routine slot: its source names a job this runtime recorded. */
  created(event: Event): boolean {
    const { actorId, sourceKind, sourceEventId } = event.source;
    if (sourceKind !== 'worker' || !actorId.startsWith('routine:') || !sourceEventId.startsWith(`${actorId}:`)) return false;
    return this.runtime.job(sourceEventId)?.kind === TASK_KIND;
  }

  /** One pass: settle and claim due slots, run their jobs, then settle what just finished. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.ticking ??= this.pass().finally(() => { this.ticking = undefined; });
  }
  private async pass(): Promise<void> {
    if (!this.owned && !(this.owned = await this.runtime.acquire())) return;
    try {
      this.routines.tick();
      while (await this.runtime.runOnce());
      this.routines.tick();
    } catch (error) {
      // Another owner took over (this process stalled past its lease): acquire again before the next pass.
      if (error instanceof Error && error.message === 'lease_lost') this.owned = false;
      throw error;
    }
  }

  /** A failing pass is reported once per run of failures and retried next second, like the executor. */
  start(onError: (error: Error) => void): void {
    if (this.timer || this.stopped) throw new Error('routines_not_startable');
    this.timer = setInterval(() => {
      void this.tick().then(() => { this.failing = false; }, (cause: unknown) => {
        if (!this.failing) onError(cause instanceof Error ? cause : new Error(String(cause)));
        this.failing = true;
      });
    }, 1000);
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer);
    await Promise.allSettled([this.ticking]);
    await this.runtime.stop();
    this.routines.close(); this.runtime.close();
  }
}
