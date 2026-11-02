import { createHash } from 'node:crypto';
import { localEnvironment, type Environment } from '../environment/local.ts';
import type { StoredEvent, TaskStore } from '../store/db.ts';
import type { DeliveredNotification, NotificationCategory, NotificationCenter, NotificationChannel } from './center.ts';
import { singleFlight } from '../single-flight.ts';

/**
 * Turns task events into notifications and pushes them. It reads the task log from a stored cursor, so a restart
 * neither repeats nor floods: the first run starts at the end of history. A notice id is task + revision, so an
 * event replayed after a crash is a no-op in the center. Only the category reaches the transport, never the title.
 */
export type TaskNotifierOptions = {
  store: TaskStore; center: NotificationCenter; channel: NotificationChannel;
  transport: (note: DeliveredNotification) => void | Promise<void>;
};

const PAGE = 100;
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,180}$/;

function categoryFor({ operation, task }: StoredEvent): NotificationCategory | null {
  if (operation === 'create') return task.status === 'suggested' ? 'task_suggested' : null;
  if (operation !== 'transition') return null;
  switch (task.status) {
    case 'needs_input': return 'task_needs_input';
    case 'ready_for_review': return 'task_ready_for_review';
    case 'succeeded': return 'task_finished';
    case 'failed': return 'task_failed';
    default: return null;
  }
}

export class TaskNotifier {
  private readonly options: TaskNotifierOptions;
  private timer: NodeJS.Timeout | undefined;
  constructor(options: TaskNotifierOptions) { this.options = { ...options }; }

  /** One pass: record notices for new task events, then push pending ones. Concurrent calls share the running pass. */
  readonly poll: () => Promise<void> = singleFlight(() => this.pass());
  private async pass(): Promise<void> {
    const { store, center, channel, transport } = this.options;
    const name = `tasks:${channel}`;
    let cursor = center.cursor(name);
    if (cursor === null) { cursor = store.nextSequence() - 1; center.setCursor(name, cursor); }
    for (;;) {
      const page = store.events(cursor, PAGE);
      for (const stored of page) {
        const category = categoryFor(stored);
        if (category) {
          const ref = OPAQUE_REF.test(stored.task.taskId) ? stored.task.taskId : `task-${createHash('sha256').update(stored.task.taskId).digest('hex').slice(0, 32)}`;
          center.notify({ id: `${ref}:r${stored.task.revision}`, channel, category, ref });
        }
        cursor = stored.event.sequence;
      }
      center.setCursor(name, cursor);
      if (page.length < PAGE) break;
    }
    await center.deliver(channel, transport);
  }

  start(intervalMs: number, onError: () => void): void {
    this.stop();
    this.timer = setInterval(() => { this.poll().catch(onError); }, intervalMs);
    this.timer.unref();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
}

/** Windows toast through the environment port (the `toast` action): fixed text, the app id and script are the port's. */
export function windowsToast(environment: Environment = localEnvironment): (note: DeliveredNotification) => Promise<void> {
  return async note => {
    const result = await environment.run({ action: 'toast', text: note.text });
    if (result.code !== 0) throw new Error('toast_failed');
  };
}
