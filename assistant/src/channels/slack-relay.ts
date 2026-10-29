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
  private lastRead = 0;
  private poster: SlackPoster | undefined;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: { databasePath: string; profileId: string; now?: () => number }) {
    this.profileId = options.profileId; this.now = options.now ?? Date.now;
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
      // Best effort and logged by the caller's socket line only; the message itself is already durable in the queue.
      this.pending = this.pending.then(() => poster.send(OFFLINE_RECEIPT, message.thread ?? message.ts)).catch(() => undefined);
    }
    return 'relayed';
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
const PART = 3900;

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

/** Posts to the operator's DM with the app's bot token. The destination is the configured operator, never an argument. */
export class SlackPoster {
  private readonly options: { botToken: string; operator: string; fetch: typeof fetch };
  constructor(options: { botToken: string; operator: string; fetch?: typeof fetch }) {
    if (!/^xoxb-[\x21-\x7e]+$/.test(options.botToken)) throw new Error('invalid_bot_token');
    if (!/^[UW][A-Z0-9]{2,20}$/.test(options.operator)) throw new Error('invalid_operator');
    this.options = { fetch: globalThis.fetch, ...options };
  }

  async send(text: string, threadTs?: string): Promise<{ parts: number; ts: string }> {
    const chunks = parts(slackText(text));
    if (!chunks.length) throw new Error('empty_message');
    let ts = '';
    for (const chunk of chunks) {
      const response = await this.options.fetch(POST_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${this.options.botToken}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: this.options.operator, text: chunk, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false }),
      });
      const body = await response.json() as { ok?: boolean; ts?: unknown; error?: unknown };
      if (!body.ok) throw new Error(`slack_${typeof body.error === 'string' ? body.error.replace(/[^\w.-]/g, '').slice(0, 60) : `http_${response.status}`}`);
      ts = typeof body.ts === 'string' ? body.ts : ts;
    }
    return { parts: chunks.length, ts };
  }
}
