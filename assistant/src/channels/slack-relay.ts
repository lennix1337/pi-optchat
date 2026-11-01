import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The Slack DM as a chat with the operator's OptChat session. Operator DMs (already authenticated by Socket Mode, the
 * workspace/app check and the sender list) are queued here; the Pi session polls the queue over the loopback API and
 * answers through `SlackPoster`, whose destination is fixed to the operator. Remote text stays the operator's words
 * from a remote device: it never carries terminal approval authority (Pi marks it as extension input).
 */
/** A Slack file the operator sent: only Slack's own file host is a trusted download. */
export type SlackFile = { id: string; name: string; mimetype: string; url: string };
export type RelayMessage = { seq: number; sender: string; channel: string; ts: string; thread: string | null; text: string; receivedAt: string; files?: SlackFile[] };
export type QueuedMessage = { delivery: string; sender: string; channel: string; ts: string; thread?: string; text: string; files?: SlackFile[] };
/** The relay's channel for a message the operator forwarded with the shortcut: answered in the DM, never in the source channel. */
export const FORWARD_CHANNEL = 'forward';
const FILE_HOST = /^https:\/\/files\.slack\.com\//;

/** Slack's file objects reduced to what the chat needs; anything not hosted by Slack is dropped. */
export function slackFiles(value: unknown): SlackFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(f => {
    const url = typeof f?.url_private_download === 'string' ? f.url_private_download : f?.url_private;
    if (typeof f?.id !== 'string' || typeof url !== 'string' || !FILE_HOST.test(url)) return [];
    return [{ id: f.id, name: typeof f.name === 'string' ? f.name.slice(0, 200) : f.id, mimetype: typeof f.mimetype === 'string' ? f.mimetype : 'application/octet-stream', url }];
  }).slice(0, 10);
}

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
    const columns = this.db.prepare('PRAGMA table_info(slack_relay)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'files')) this.db.exec('ALTER TABLE slack_relay ADD COLUMN files TEXT');
  }

  /** The poster used for the offline receipt; optional, so intake works before a bot token is configured. */
  attach(poster: SlackPoster): void { this.poster = poster; }

  enqueue(message: QueuedMessage): 'relayed' | 'duplicate' {
    const files = message.files?.length ? JSON.stringify(message.files) : null;
    const result = this.db.prepare('INSERT OR IGNORE INTO slack_relay (profile, delivery, sender, channel, ts, thread, text, received_at, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.profileId, message.delivery, message.sender, message.channel, message.ts, message.thread ?? null, message.text.slice(0, MAX_TEXT), new Date(this.now()).toISOString(), files);
    if (!result.changes) return 'duplicate';
    if (this.poster && this.now() - this.lastRead > READER_GRACE_MS) {
      const poster = this.poster;
      const channel = message.channel.startsWith('D') || message.channel === FORWARD_CHANNEL ? undefined : poster.nameOf(message.channel);
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
    const rows = this.db.prepare('SELECT seq, sender, channel, ts, thread, text, received_at, files FROM slack_relay WHERE profile = ? AND seq > ? ORDER BY seq LIMIT ?').all(this.profileId, seq, limit) as Record<string, string | number | null>[];
    return rows.map(row => ({ seq: Number(row.seq), sender: String(row.sender), channel: String(row.channel), ts: String(row.ts), thread: row.thread === null ? null : String(row.thread), text: String(row.text), receivedAt: String(row.received_at), ...(row.files ? { files: JSON.parse(String(row.files)) as SlackFile[] } : {}) }));
  }

  /** Settles pending automatic receipts (tests, shutdown). */
  idle(): Promise<unknown> { return this.pending; }
  close(): void { this.db.close(); }
}

const POST_URL = 'https://slack.com/api/chat.postMessage';
const UPDATE_URL = 'https://slack.com/api/chat.update';
const API = 'https://slack.com/api/';
const MAX_DOWNLOAD = 50 * 1024 * 1024;
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
  async send(text: string, threadTs?: string, channel?: string, options: { approval?: boolean; broadcast?: boolean } = {}): Promise<{ parts: number; ts: string; channel?: string }> {
    const destination = channel === undefined ? this.options.operator : Object.hasOwn(this.options.channels, channel) ? this.options.channels[channel] : undefined;
    if (!destination) throw new Error('unknown_channel');
    const chunks = parts(slackText(text));
    if (!chunks.length) throw new Error('empty_message');
    const buttons = options.approval && chunks.length === 1 && chunks[0]!.length <= SECTION_MAX;
    let ts = '', posted: string | undefined;
    for (const chunk of chunks) {
      const body = await this.call(POST_URL, { channel: destination, text: chunk, ...(buttons ? { blocks: approvalBlocks(chunk) } : {}), ...(threadTs ? { thread_ts: threadTs, ...(options.broadcast ? { reply_broadcast: true } : {}) } : {}), unfurl_links: false });
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

  /** Marks a message the operator wrote (DM or a configured channel) with an emoji: seen, done. */
  async react(channel: string, ts: string, name: string, remove = false): Promise<void> {
    if (!/^D[A-Z0-9]{2,20}$/.test(channel) && !Object.values(this.options.channels).includes(channel)) throw new Error('unknown_channel');
    try { await this.call(`${API}reactions.${remove ? 'remove' : 'add'}`, { channel, timestamp: ts, name }); }
    catch (error) { if (!/already_reacted|no_reaction/.test((error as Error).message)) throw error; }
  }

  /** Reads one message the operator linked (read-only); the bot sees only conversations it is in. */
  async fetchMessage(channel: string, ts: string, thread = ts): Promise<{ user: string; text: string; files: SlackFile[] }> {
    if (!/^[CDG][A-Z0-9]{2,20}$/.test(channel)) throw new Error('unknown_channel');
    // A reply is read through its thread; the parent always comes first, so the target is picked by ts.
    const body = await this.call(`${API}conversations.replies`, { channel, ts: thread, oldest: ts, latest: ts, inclusive: true, limit: 2 }, true) as { messages?: Record<string, unknown>[] };
    const message = body.messages?.find(m => m.ts === ts);
    if (!message) throw new Error('message_not_found');
    return { user: typeof message.user === 'string' ? message.user : '', text: typeof message.text === 'string' ? message.text : '', files: slackFiles(message.files) };
  }

  /** The operator's App Home: what the assistant is doing now. */
  async publishHome(markdown: string): Promise<void> {
    const text = slackText(markdown).slice(0, SECTION_MAX);
    await this.call(`${API}views.publish`, { user_id: this.options.operator, view: { type: 'home', blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] } });
  }

  /** Saves a Slack-hosted file under `<dir>/slack-files`, so the agent can read an image or transcribe audio. */
  async download(url: string, name: string, dir: string): Promise<{ path: string; bytes: number }> {
    if (!FILE_HOST.test(url)) throw new Error('invalid_file_url');
    const response = await this.options.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${this.options.botToken}` } });
    if (!response.ok) throw new Error(`slack_http_${response.status}`);
    // Without the files:read scope Slack answers with its HTML login page, not an error status.
    if (/^text\/html/.test(response.headers.get('content-type') ?? '')) throw new Error('slack_file_forbidden');
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_DOWNLOAD) throw new Error('file_too_large');
    const folder = join(dir, 'slack-files');
    mkdirSync(folder, { recursive: true });
    const safe = basename(name.replace(/\\/g, '/')).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-120) || 'file';
    const path = join(folder, `${Date.now()}-${safe}`);
    writeFileSync(path, data);
    return { path, bytes: data.length };
  }

  private async call(url: string, payload: Record<string, unknown>, form = false): Promise<{ ts?: unknown; channel?: unknown }> {
    const response = await this.options.fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${this.options.botToken}`, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' },
      // Read methods take form fields.
      body: form ? new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(payload),
    });
    const body = await response.json() as { ok?: boolean; ts?: unknown; channel?: unknown; error?: unknown };
    if (!body.ok) throw new Error(`slack_${typeof body.error === 'string' ? body.error.replace(/[^\w.-]/g, '').slice(0, 60) : `http_${response.status}`}`);
    return body;
  }
}
