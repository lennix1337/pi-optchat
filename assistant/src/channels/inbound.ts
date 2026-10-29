import { randomUUID } from 'node:crypto';
import { sha256 } from '../hash.ts';
import { DatabaseSync } from 'node:sqlite';
import type { Event } from '../contracts/events.ts';
import type { Task } from '../contracts/tasks.ts';
import type { TaskStore } from '../store/db.ts';
import type { EffectMetadata, Gateway } from '../policy/gateway.ts';

/**
 * Shared ground for remote chat channels (Slack, Teams). A remote sender is `external`: it can suggest work and
 * answer the exact input it was asked, never approve an effect or administer the profile. Approve buttons and
 * "aprovar" text resolve to a link to the authenticated local review.
 */
export type Platform = 'slack' | 'teams';
export type Outcome = 'unauthenticated' | 'foreign_workspace' | 'duplicate' | 'ignored_not_human' | 'unauthorized_sender'
  | 'task_created' | 'responded' | 'stale' | 'review_required' | 'ignored' | 'relayed';
export type Received = { outcome: Outcome; taskId?: string; reply?: string };
export type ThreadBinding = { platform: Platform; account: string; conversation: string; thread: string; taskId: string; revision: number; inputRevision: number };

const fail = (code: string): never => { throw new Error(code); };

export class ChannelLedger {
  private readonly db: DatabaseSync;
  private readonly profileId: string;
  private readonly authority: object;
  constructor(options: { databasePath: string; profileId: string; operatorAuthority: object }) {
    if (!options.operatorAuthority || typeof options.operatorAuthority !== 'object' || !options.profileId) fail('invalid_options');
    this.profileId = options.profileId; this.authority = options.operatorAuthority;
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS channel_senders (profile TEXT NOT NULL, platform TEXT NOT NULL, account TEXT NOT NULL, sender TEXT NOT NULL, label TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(profile, platform, account, sender));
      CREATE TABLE IF NOT EXISTS channel_threads (profile TEXT NOT NULL, platform TEXT NOT NULL, account TEXT NOT NULL, conversation TEXT NOT NULL, thread TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL, input_revision INTEGER NOT NULL, PRIMARY KEY(profile, platform, account, conversation, thread));`);
  }
  authorize(platform: Platform, account: string, sender: string, label: string, authority: object): void {
    if (authority !== this.authority) fail('unauthorized');
    this.db.prepare('INSERT INTO channel_senders VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT DO UPDATE SET label = excluded.label, revoked = 0').run(this.profileId, platform, account, sender, label);
  }
  revoke(platform: Platform, account: string, sender: string, authority: object): void {
    if (authority !== this.authority) fail('unauthorized');
    this.revokeAll(platform, account, sender);
  }
  /** Revokes one sender, or every sender of the account when `sender` is omitted. Callers check authority. */
  private revokeAll(platform: Platform, account: string, sender?: string): void {
    const one = sender === undefined ? '' : ' AND sender = ?';
    this.db.prepare(`UPDATE channel_senders SET revoked = 1 WHERE profile = ? AND platform = ? AND account = ?${one}`).run(this.profileId, platform, account, ...(sender === undefined ? [] : [sender]));
  }
  /** Makes `senders` the exact authorized set for one account: anyone dropped from the operator's list is revoked. */
  replaceSenders(platform: Platform, account: string, senders: readonly string[], label: string, authority: object): void {
    if (authority !== this.authority) fail('unauthorized');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.revokeAll(platform, account);
      for (const sender of senders) this.authorize(platform, account, sender, label, authority);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  authorized(platform: Platform, account: string, sender: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM channel_senders WHERE profile = ? AND platform = ? AND account = ? AND sender = ? AND revoked = 0').get(this.profileId, platform, account, sender));
  }
  recordThread(binding: ThreadBinding): void {
    this.db.prepare('INSERT OR REPLACE INTO channel_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(this.profileId, binding.platform, binding.account, binding.conversation, binding.thread, binding.taskId, binding.revision, binding.inputRevision);
  }
  thread(platform: Platform, account: string, conversation: string, thread: string): ThreadBinding | null {
    const row = this.db.prepare('SELECT * FROM channel_threads WHERE profile = ? AND platform = ? AND account = ? AND conversation = ? AND thread = ?').get(this.profileId, platform, account, conversation, thread) as Record<string, string | number> | undefined;
    return row ? { platform, account, conversation, thread, taskId: String(row.task_id), revision: Number(row.revision), inputRevision: Number(row.input_revision) } : null;
  }
  close(): void { this.db.close(); }
}

export type RemoteMessage = {
  platform: Platform; account: string; delivery: string; sender: string; human: boolean;
  conversation: string; messageId: string; thread?: string; text: string;
};
export type AdmitOptions = { store: TaskStore; ledger: ChannelLedger; profileId: string; now: () => number; reviewLink: (taskId: string) => string };
const MAX_TITLE = 200;

/** Every remote message goes through here after the platform verified its signature and workspace. */
export function admit(message: RemoteMessage, options: AdmitOptions): Received {
  const { store, ledger, profileId } = options;
  if (!message.human) return { outcome: 'ignored_not_human' };
  if (!ledger.authorized(message.platform, message.account, message.sender)) return { outcome: 'unauthorized_sender' };
  const text = message.text.trim();
  if (!text) return { outcome: 'ignored' };
  const sourceEventId = `${message.platform}:${message.account}:${message.delivery}`;
  const event = (taskId: string): Event => ({
    version: 1, eventId: randomUUID(), profileId, taskId, sessionId: `${message.platform}:${message.conversation}`,
    channelId: `${message.platform}:${message.conversation}`, runId: `${message.platform}-channel`,
    source: { actorId: `${message.platform}:${message.account}:${message.sender}`, sourceKind: 'external', sourceEventId },
    observedAt: new Date(options.now()).toISOString(), sequence: store.nextSequence(), correlationId: sourceEventId,
    evidence: { kind: 'observed', reference: `${message.platform}://${message.account}/${message.conversation}/${message.messageId}` },
  });
  const binding = message.thread ? ledger.thread(message.platform, message.account, message.conversation, message.thread) : null;
  if (binding) {
    const current = store.get(binding.taskId);
    // Any later change to the task (answer, new question, cancel) bumps its revision, so the binding is exact.
    if (!current || current.status !== 'needs_input' || current.revision !== binding.revision) return { outcome: 'stale', taskId: binding.taskId, reply: options.reviewLink(binding.taskId) };
    store.respond({ version: 1, profileId, taskId: current.taskId, revision: current.revision, inputRevision: current.inputRevision, text: text.slice(0, 4000) }, event(current.taskId));
    return { outcome: 'responded', taskId: current.taskId };
  }
  // The task ID derives from the delivery, so a redelivery (retry, restart) finds the task instead of making another.
  const taskId = `${message.platform}-${sha256(sourceEventId).slice(0, 32)}`;
  if (store.get(taskId)) return { outcome: 'duplicate', taskId };
  const title = [...text.replace(/\s+/g, ' ')].slice(0, MAX_TITLE).join('');
  store.create({ version: 1, profileId, taskId, title, status: 'suggested', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId }, event(taskId));
  return { outcome: 'task_created', taskId };
}

export type Notice = { operationId: string; platform: Platform; account: string; conversation: string; thread?: string; taskId: string; text: string; expiresAt: number };
export type Transport = (bytes: Uint8Array, metadata: Readonly<EffectMetadata>) => Promise<{ thread: string }>;
export type SendOutcome = 'sent' | 'approval_required' | 'denied' | 'already_dispatched' | 'effect_uncertain' | 'invalid';

/** Outbound messages are effects: gateway policy, egress inspection, single dispatch, no resend of an ambiguous post. */
export class ChannelSender {
  private readonly options: { gateway: Gateway; ledger: ChannelLedger; profileId: string; transport: Transport };
  constructor(options: { gateway: Gateway; ledger: ChannelLedger; profileId: string; transport: Transport }) { this.options = options; }
  async notify(notice: Notice, task?: Task): Promise<{ outcome: SendOutcome }> {
    const { gateway, ledger, profileId, transport } = this.options;
    const request = {
      version: 1 as const, operationId: notice.operationId, profileId, sessionId: `${notice.platform}-notices`, taskId: notice.taskId, runId: `${notice.platform}-channel`,
      adapter: notice.platform, action: 'post_message', account: notice.account, destination: notice.thread ? `${notice.conversation}#${notice.thread}` : notice.conversation,
      policyVersion: '1', expiresAt: notice.expiresAt, payload: new TextEncoder().encode(notice.text),
    };
    let posted: { thread: string };
    try {
      posted = await gateway.dispatch(request, (bytes, metadata) => transport(bytes, metadata));
    } catch (error) {
      const code = (error as Error).message;
      if (code === 'approval_required' || code === 'denied' || code === 'effect_uncertain') return { outcome: code };
      if (code === 'operation_already_dispatched') return { outcome: 'already_dispatched' };
      return { outcome: 'invalid' };
    }
    // A question binds replies in its thread to the exact input it asked for.
    if (task?.status === 'needs_input' && task.taskId === notice.taskId) {
      ledger.recordThread({ platform: notice.platform, account: notice.account, conversation: notice.conversation, thread: posted.thread, taskId: task.taskId, revision: task.revision, inputRevision: task.inputRevision });
    }
    return { outcome: 'sent' };
  }
}
