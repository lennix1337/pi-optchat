import { DatabaseSync } from 'node:sqlite';
import { boundedInteger } from '../limits.ts';
import { immediate } from '../store/transaction.ts';

/**
 * Human-facing local/web notifications. A notification carries only a category and an opaque reference: the
 * transport (lock screen, toast, browser) receives fixed text per category, never task titles, content or secrets.
 * Pushing needs operator consent per channel and waits out quiet hours. Transport acceptance (`accepted`) is not
 * human reading (`read`); only `markRead` from a human surface records that. Delivery is at least once by stable id.
 */
export type NotificationChannel = 'local' | 'web';
export type NotificationCategory = keyof typeof lockScreenText;
export type NotificationState = 'pending' | 'suppressed' | 'accepted' | 'read' | 'failed';
export type NotificationInput = { id: string; channel: NotificationChannel; category: NotificationCategory; ref: string };
export type NotificationRecord = NotificationInput & {
  state: NotificationState; reason: string | null; attempts: number; createdAt: number; acceptedAt: number | null; readAt: number | null;
};
export type DeliveredNotification = { id: string; text: string; ref: string };
export type QuietHours = { start: string; end: string; timeZone: string };
export type NotificationCenterOptions = {
  databasePath: string; operatorAuthority: object; now?: () => number; maxAttempts?: number;
  /** Test seam: called after each durable boundary so a test can fail exactly there. */
  boundary?: (name: string, id: string) => void;
};
type Row = { id: string; channel: NotificationChannel; category: NotificationCategory; ref: string; state: NotificationState; reason: string | null;
  attempts: number; created: number; accepted: number | null; read: number | null };

const lockScreenText = {
  task_suggested: 'A new task was suggested to the assistant.',
  task_needs_input: 'An assistant task needs your input.',
  task_ready_for_review: 'An assistant task is ready for review.',
  task_finished: 'An assistant task finished.',
  task_failed: 'An assistant task failed.',
  briefing_ready: 'Your daily briefing is ready.',
  approval_pending: 'An assistant action is waiting for your review.',
  effect_uncertain: 'An assistant action needs reconciliation.',
  routine_paused: 'An assistant routine was paused.',
} as const;
const channels: readonly string[] = ['local', 'web'];
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseInput(value: unknown): NotificationInput {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || Object.keys(v).sort().join(',') !== 'category,channel,id,ref' || typeof v.id !== 'string' || !OPAQUE_ID.test(v.id)
    || typeof v.ref !== 'string' || !OPAQUE_ID.test(v.ref) || !channels.includes(v.channel as string) || typeof v.category !== 'string'
    || !Object.hasOwn(lockScreenText, v.category)) throw new Error('invalid_notification');
  return { id: v.id, channel: v.channel as NotificationChannel, category: v.category as NotificationCategory, ref: v.ref };
}
function minutes(clock: string): number { const [, h, m] = CLOCK.exec(clock)!; return Number(h) * 60 + Number(m); }
function parseQuietHours(value: QuietHours): QuietHours {
  if (!value || typeof value !== 'object' || typeof value.start !== 'string' || typeof value.end !== 'string' || !CLOCK.test(value.start)
    || !CLOCK.test(value.end) || value.start === value.end || typeof value.timeZone !== 'string') throw new Error('invalid_quiet_hours');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }); } catch { throw new Error('invalid_quiet_hours'); }
  return { start: value.start, end: value.end, timeZone: value.timeZone };
}
function localMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(instant);
  return Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
}
/** Quiet hours are [start, end) local time; an end before the start wraps across midnight. */
function inQuietHours(quiet: QuietHours, instant: number): boolean {
  const now = localMinutes(instant, quiet.timeZone), start = minutes(quiet.start), end = minutes(quiet.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export class NotificationCenter {
  private readonly db: DatabaseSync;
  private readonly options: NotificationCenterOptions;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  constructor(options: NotificationCenterOptions) {
    if (!options?.operatorAuthority || typeof options.operatorAuthority !== 'object') throw new Error('invalid_options');
    this.options = { ...options };
    this.now = options.now ?? Date.now;
    this.maxAttempts = boundedInteger(options.maxAttempts, 3, 1, 100);
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS notification_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, changed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, channel TEXT NOT NULL, category TEXT NOT NULL,
        ref TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, accepted INTEGER, read INTEGER,
        UNIQUE (id, channel));`);
  }
  private authorize(authority: object): void { if (authority !== this.options.operatorAuthority) throw new Error('unauthorized'); }
  private setting(name: string, value: unknown): void {
    this.db.prepare('INSERT INTO notification_settings VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, changed = excluded.changed')
      .run(name, JSON.stringify(value), this.now());
  }
  private read<T>(name: string): T | null {
    const row = this.db.prepare('SELECT value FROM notification_settings WHERE name = ?').get(name) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : null;
  }

  /** Consent to push on one channel; revoking stops further pushes. Only the operator authority may change it. */
  setConsent(channel: NotificationChannel, granted: boolean, authority: object): void {
    this.authorize(authority);
    if (!channels.includes(channel) || typeof granted !== 'boolean') throw new Error('invalid_consent');
    this.setting(`consent:${channel}`, granted);
  }
  setQuietHours(quiet: QuietHours | null, authority: object): void {
    this.authorize(authority);
    this.setting('quiet_hours', quiet === null ? null : parseQuietHours(quiet));
  }

  /** A producer's resume point (for example the last task event it turned into notifications); null before its first run. */
  cursor(name: string): number | null {
    const value = this.read<number>(`cursor:${name}`);
    return typeof value === 'number' ? value : null;
  }
  setCursor(name: string, value: number): void {
    if (typeof name !== 'string' || !OPAQUE_ID.test(name) || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid_cursor');
    this.setting(`cursor:${name}`, value);
  }

  /** Same id, channel, category and ref is a no-op; reusing an id for different content is `notification_conflict`. */
  notify(input: NotificationInput): void {
    const note = parseInput(input);
    immediate(this.db, () => {
      const existing = this.db.prepare('SELECT category, ref FROM notifications WHERE id = ? AND channel = ?').get(note.id, note.channel) as { category: string; ref: string } | undefined;
      if (existing && (existing.category !== note.category || existing.ref !== note.ref)) throw new Error('notification_conflict');
      if (!existing) this.db.prepare("INSERT INTO notifications (id, channel, category, ref, state, created) VALUES (?, ?, ?, ?, 'pending', ?)")
        .run(note.id, note.channel, note.category, note.ref, this.now());
    });
  }

  /**
   * Pushes pending notifications of one channel. Without consent they become `suppressed` (still listed, never pushed);
   * during quiet hours they stay pending. A transport failure keeps only a fixed diagnostic and fails after maxAttempts.
   */
  async deliver(channel: NotificationChannel, transport: (note: DeliveredNotification) => void | Promise<void>, limit = 50): Promise<{ accepted: number; deferred: number; suppressed: number; failed: number }> {
    if (!channels.includes(channel)) throw new Error('invalid_channel');
    const rows = this.db.prepare("SELECT * FROM notifications WHERE channel = ? AND state = 'pending' ORDER BY seq LIMIT ?").all(channel, boundedInteger(limit, 50, 1, 500)) as Row[];
    const result = { accepted: 0, deferred: 0, suppressed: 0, failed: 0 };
    for (const row of rows) {
      if (this.read<boolean>(`consent:${channel}`) !== true) {
        this.db.prepare("UPDATE notifications SET state = 'suppressed', reason = 'no_consent' WHERE id = ? AND channel = ? AND state = 'pending'").run(row.id, channel);
        result.suppressed++; continue;
      }
      const quiet = this.read<QuietHours>('quiet_hours');
      if (quiet && inQuietHours(quiet, this.now())) { result.deferred++; continue; }
      try { await transport({ id: row.id, text: lockScreenText[row.category], ref: row.ref }); }
      catch {
        const exhausted = row.attempts + 1 >= this.maxAttempts;
        this.db.prepare('UPDATE notifications SET attempts = attempts + 1, state = ?, reason = ? WHERE id = ? AND channel = ?')
          .run(exhausted ? 'failed' : 'pending', 'delivery_failed', row.id, channel);
        result.failed++; continue;
      }
      this.options.boundary?.('transport_accepted', row.id);
      this.db.prepare("UPDATE notifications SET attempts = attempts + 1, state = 'accepted', reason = NULL, accepted = ? WHERE id = ? AND channel = ? AND state = 'pending'").run(this.now(), row.id, channel);
      result.accepted++;
    }
    return result;
  }

  /** A human surface (terminal, authenticated web session) reports that the person opened it. Idempotent. */
  markRead(id: string, channel: NotificationChannel): void {
    immediate(this.db, () => {
      const row = this.db.prepare('SELECT state FROM notifications WHERE id = ? AND channel = ?').get(id, channel) as { state: NotificationState } | undefined;
      if (!row || (row.state !== 'accepted' && row.state !== 'read')) throw new Error('not_delivered');
      this.db.prepare("UPDATE notifications SET state = 'read', read = COALESCE(read, ?) WHERE id = ? AND channel = ?").run(this.now(), id, channel);
    });
  }

  list(): NotificationRecord[] {
    return (this.db.prepare('SELECT * FROM notifications ORDER BY seq').all() as Row[]).map(r => ({
      id: r.id, channel: r.channel, category: r.category, ref: r.ref, state: r.state, reason: r.reason, attempts: r.attempts,
      createdAt: r.created, acceptedAt: r.accepted, readAt: r.read,
    }));
  }
  close(): void { this.db.close(); }
}

export function createNotificationCenter(options: NotificationCenterOptions): NotificationCenter { return new NotificationCenter(options); }
