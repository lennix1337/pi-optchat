import { dirname, join } from 'node:path';
import type { Config } from '../main.ts';
import { prepareDatabase } from '../store/privacy.ts';
import type { Event } from '../contracts/events.ts';
import type { TaskStore } from '../store/db.ts';
import { piDraftEngine } from './pi-draft.ts';
import { TaskExecutor, type DraftRunner, type ExecutorOptions } from './task-executor.ts';

/** Opens the opt-in executor's private job database next to the task store; it takes the lease on its first free tick. */
export function openTaskExecutor(config: Config, store: TaskStore, admit?: (origin: Event) => boolean, tools?: NonNullable<ExecutorOptions['tools']> & { run?: DraftRunner }): TaskExecutor {
  const settings = config.executor!;
  const directory = dirname(config.databasePath);
  const databasePath = tools ? config.databasePath : join(directory, 'executor.sqlite');
  if (!tools) prepareDatabase(databasePath);
  const engine = piDraftEngine(settings, directory);
  return new TaskExecutor({ store, profileId: config.profileId, databasePath, channels: settings.channels, run: tools?.run ?? engine.run, ready: tools?.run ? undefined : engine.ready, ...(admit ? { admit } : {}), ...(tools ? { tools } : {}) });
}
