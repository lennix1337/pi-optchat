import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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

export type RunProcess = (file: string, args: string[], env: Record<string, string | undefined>) => Promise<number>;

const TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode('OptChat')) > $null
$t.Item(1).AppendChild($x.CreateTextNode($env:OPTCHAT_TOAST_TEXT)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;

const runProcess: RunProcess = (file, args, env) => new Promise(resolve => {
  execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: 20_000 }, error => {
    resolve(error ? (typeof error.code === 'number' ? error.code : 1) : 0);
  });
});

/** Windows toast through Windows PowerShell's registered app id. The text travels in the environment, not the command line. */
export function windowsToast(run: RunProcess = runProcess): (note: DeliveredNotification) => Promise<void> {
  const encoded = Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64');
  return async note => {
    const code = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { OPTCHAT_TOAST_TEXT: note.text });
    if (code !== 0) throw new Error('toast_failed');
  };
}
