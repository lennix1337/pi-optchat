import { DatabaseSync } from 'node:sqlite';

/**
 * The Slack DM as a chat with the operator's OptChat session. Operator DMs (already authenticated by Socket Mode, the
 * workspace/app check and the sender list) are queued here; the Pi session polls the queue over the loopback API and
 * answers through `SlackPoster`, whose destination is fixed to the operator. Remote text stays the operator's words
 * from a remote device: it never carries terminal approval authority (Pi marks it as extension input).
 */
export type RelayMessage = { seq: number; sender: string; channel: string; ts: string; thread: string | null; text: string; receivedAt: string };
export type QueuedMessage = { delivery: string; sender: string; channel: string; ts: string; thread?: string; text: string };

const MAX_TEXT = 8000;
/** Without a reader for this long, a new DM gets an automatic receipt so the operator knows it waits in the queue. */
const READER_GRACE_MS = 2 * 60_000;
const OFFLINE_RECEIPT = 'Recebi. O OptChat não está aberto agora; sua mensagem ficou na fila e eu respondo assim que ele voltar.';

export class SlackRelay {
  private readonly db: DatabaseSync;
  private readonly profileId: string;
  private readonly now: () => number;
  /** Starts at construction: right after a service restart the open session has not polled yet, not gone away. */
  private lastRead: number;
  private poster: SlackPoster | undefined;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: { databasePath: string; profileId: string; now?: () => number }) {
    this.profileId = options.profileId; this.now = options.now ?? Date.now;
    this.lastRead = this.now();
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS slack_relay (seq INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL, delivery TEXT NOT NULL, sender TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT, text TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(profile, delivery));`);
  }

  /** The poster used for the offline receipt; optional, so intake works before a bot token is configured. */
  attach(poster: SlackPoster): void { this.poster = poster; }

  enqueue(message: QueuedMessage): 'relayed' | 'duplicate' {
    const result = this.db.prepare('INSERT OR IGNORE INTO slack_relay (profile, delivery, sender, channel, ts, thread, text, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.profileId, message.delivery, message.sender, message.channel, message.ts, message.thread ?? null, message.text.slice(0, MAX_TEXT), new Date(this.now()).toISOString());
    if (!result.changes) return 'duplicate';
    if (this.poster && this.now() - this.lastRead > READER_GRACE_MS) {
      const poster = this.poster;
      const channel = message.channel.startsWith('D') ? undefined : poster.nameOf(message.channel);
      // Best effort and logged by the caller's socket line only; the message itself is already durable in the queue.
      if (channel !== null) this.pending = this.pending.then(() => poster.send(OFFLINE_RECEIPT, message.thread ?? message.ts, channel)).catch(() => undefined);
    }
    return 'relayed';
  }

  /** Replaces an approval post once a click on it was queued, so its buttons cannot be pressed again. Best effort. */
  retire(channel: string, ts: string, text: string): void {
    const poster = this.poster;
    if (poster) this.pending = this.pending.then(() => poster.update(channel, ts, text)).catch(() => undefined);
  }

  /** Messages after `seq`, oldest first. Reading marks a reader as present. */
  after(seq: number, limit: number): RelayMessage[] {
    this.lastRead = this.now();
    const rows = this.db.prepare('SELECT seq, sender, channel, ts, thread, text, received_at FROM slack_relay WHERE profile = ? AND seq > ? ORDER BY seq LIMIT ?').all(this.profileId, seq, limit) as Record<string, string | number | null>[];
    return rows.map(row => ({ seq: Number(row.seq), sender: String(row.sender), channel: String(row.channel), ts: String(row.ts), thread: row.thread === null ? null : String(row.thread), text: String(row.text), receivedAt: String(row.received_at) }));
  }

  /** Settles pending automatic receipts (tests, shutdown). */
  idle(): Promise<unknown> { return this.pending; }
  close(): void { this.db.close(); }
}

const POST_URL = 'https://slack.com/api/chat.postMessage';
const UPDATE_URL = 'https://slack.com/api/chat.update';
const PART = 3900;
/** Slack's limit for a section block's text; a longer approval post goes out without buttons (a thread reply still decides). */
const SECTION_MAX = 3000;
/** The button ids `SlackChannel` turns into the operator's `aprovar`/`negar` in the post's thread. */
export const APPROVAL_ACTIONS: Readonly<Record<string, 'aprovar' | 'negar'>> = { optchat_approve: 'aprovar', optchat_deny: 'negar' };

function approvalBlocks(text: string): unknown[] {
  const button = (action_id: string, label: string, style: string) => ({ type: 'button', action_id, value: action_id, style, text: { type: 'plain_text', text: label } });
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'actions', elements: [button('optchat_approve', 'Aprovar', 'primary'), button('optchat_deny', 'Negar', 'danger')] },
  ];
}

/** Markdown from the agent to Slack mrkdwn: bold, headings and links; everything else passes through. */
export function slackText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
}

function parts(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > PART) {
    const cut = rest.lastIndexOf('\n', PART) > PART / 2 ? rest.lastIndexOf('\n', PART) : PART;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/**
 * Posts with the app's bot token to the operator's DM or to one of the configured project channels, chosen by name.
 * Destinations come from the operator's config, never from the caller as a raw id.
 */
export class SlackPoster {
  private readonly options: { botToken: string; operator: string; channels: Record<string, string>; fetch: typeof fetch };
  constructor(options: { botToken: string; operator: string; channels?: Record<string, string>; fetch?: typeof fetch }) {
    if (!/^xoxb-[\x21-\x7e]+$/.test(options.botToken)) throw new Error('invalid_bot_token');
    if (!/^[UW][A-Z0-9]{2,20}$/.test(options.operator)) throw new Error('invalid_operator');
    this.options = { fetch: globalThis.fetch, channels: {}, ...options };
  }

  /** The configured name of a project channel id, or null. */
  nameOf(id: string): string | null { return Object.entries(this.options.channels).find(([, value]) => value === id)?.[0] ?? null; }

  /** With `approval`, a one-part post also carries Aprovar/Negar buttons. */
  /** Also returns the conversation id Slack posted to (the DM's `D…` id), which `update` needs. */
  async send(text: string, threadTs?: string, channel?: string, options: { approval?: boolean } = {}): Promise<{ parts: number; ts: string; channel?: string }> {
    const destination = channel === undefined ? this.options.operator : Object.hasOwn(this.options.channels, channel) ? this.options.channels[channel] : undefined;
    if (!destination) throw new Error('unknown_channel');
    const chunks = parts(slackText(text));
    if (!chunks.length) throw new Error('empty_message');
    const buttons = options.approval && chunks.length === 1 && chunks[0]!.length <= SECTION_MAX;
    let ts = '', posted: string | undefined;
    for (const chunk of chunks) {
      const body = await this.call(POST_URL, { channel: destination, text: chunk, ...(buttons ? { blocks: approvalBlocks(chunk) } : {}), ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false });
      ts = typeof body.ts === 'string' ? body.ts : ts;
      posted = typeof body.channel === 'string' ? body.channel : posted;
    }
    return { parts: chunks.length, ts, ...(posted ? { channel: posted } : {}) };
  }

  /** Rewrites one of the bot's own DM posts as plain text, dropping its buttons. */
  async update(channel: string, ts: string, text: string): Promise<void> {
    if (!/^D[A-Z0-9]{2,20}$/.test(channel)) throw new Error('unknown_channel');
    await this.call(UPDATE_URL, { channel, ts, text: slackText(text), blocks: [] });
  }

  private async call(url: string, payload: Record<string, unknown>): Promise<{ ts?: unknown; channel?: unknown }> {
    const response = await this.options.fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${this.options.botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    const body = await response.json() as { ok?: boolean; ts?: unknown; channel?: unknown; error?: unknown };
    if (!body.ok) throw new Error(`slack_${typeof body.error === 'string' ? body.error.replace(/[^\w.-]/g, '').slice(0, 60) : `http_${response.status}`}`);
    return body;
  }
}
