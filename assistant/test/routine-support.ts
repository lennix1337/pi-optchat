import { join } from 'node:path';
import { createRuntime, type InternalHandler, type WorkerRuntime } from '../src/runtime/worker.ts';
import { createRoutines, type RoutineManager, type RoutineSpec } from '../src/routines/manager.ts';

export const utc = (iso: string) => Date.parse(iso);

export type Rig = { clock: { now: number }; runtime: WorkerRuntime; routines: RoutineManager; close(): Promise<void> };

/** In-process worker and routine manager on one disposable database, with a controlled clock. */
export async function rig(dir: string, start: string, handlers: Record<string, InternalHandler>, options: { maxQueued?: number; maxAttempts?: number } = {}): Promise<Rig> {
  const clock = { now: utc(start) };
  const databasePath = join(dir, 'assistant.db');
  const runtime = createRuntime({ databasePath, owner: 'worker', now: () => clock.now, leaseMs: 3_600_000, handlers, ...options });
  await runtime.acquire();
  const routines = createRoutines({ databasePath, runtime, now: () => clock.now });
  return { clock, runtime, routines, async close() { await runtime.stop(); routines.close(); runtime.close(); } };
}

export function daily(id: string, at = '09:00', extra: Partial<RoutineSpec> = {}): RoutineSpec {
  return { id, profileId: 'p', kind: 'brief', schedule: { kind: 'daily', at, timeZone: 'UTC' }, capabilities: ['read.inbox'], authorization: 'grant-1', ...extra };
}

export async function drain(runtime: WorkerRuntime): Promise<void> { while (await runtime.runOnce()); }
