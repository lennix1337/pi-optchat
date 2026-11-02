import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Outbox, OutboxRefused, type OutboxOptions, type OutboxRow } from '../outbox/outbox.ts';
import { immediate } from '../store/transaction.ts';

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
/** The relay's channel for a tap on an App Home button: answered in the DM. */
export const HOME_CHANNEL = 'home';
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
/** Slack's own refusals that say the post did not happen and may succeed later. */
const RETRYABLE_SLACK_ERRORS = new Set(['ratelimited', 'internal_error', 'service_unavailable']);

/** Replaces an approval post with its decided text (no buttons), queued with the click that decided it. */
export type RetireRequest = { channel: string; ts: string; text: string };

export class SlackRelay {
  private readonly db: DatabaseSync;
  private readonly profileId: string;
  private readonly now: () => number;
  /** Starts at construction: right after a service restart the open session has not polled yet, not gone away. */
  private lastRead: number;
  private poster: SlackPoster | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private retryTimer: NodeJS.Timeout | undefined;
  /** Readers held by `waitAfter`; each is ended by a new message or by its own deadline. */
  private readonly arrivals = new Set<() => void>();
  /** The relay's effects: receipts and retirements are staged with the message; HTTP writes are recorded by `record`. */
  readonly outbox: Outbox;

  constructor(options: { databasePath: string; profileId: string; now?: () => number; outbox?: OutboxOptions }) {
    this.profileId = options.profileId; this.now = options.now ?? Date.now;
    this.lastRead = this.now();
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS slack_relay (seq INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL, delivery TEXT NOT NULL, sender TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT, text TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(profile, delivery));`);
    const columns = this.db.prepare('PRAGMA table_info(slack_relay)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'files')) this.db.exec('ALTER TABLE slack_relay ADD COLUMN files TEXT');
    this.outbox = new Outbox(this.db, options.profileId, { now: this.now, ...options.outbox });
    // Before any dispatch: a send a previous process left in flight is uncertain, never resent.
    this.outbox.recover();
  }

  /** The poster that delivers the outbox; optional, so intake works before a bot token is configured. Pending rows go out now. */
  attach(poster: SlackPoster): void { this.poster = poster; this.schedule(); }

  /**
   * Queues an operator message. The message, its offline receipt and the `retire` update of the approval post it
   * answers commit in one transaction, so a crash after the commit still sends them, once, and a crash before it sends nothing.
   */
  enqueue(message: QueuedMessage, retire?: RetireRequest): 'relayed' | 'duplicate' {
    const files = message.files?.length ? JSON.stringify(message.files) : null;
    const relayed = immediate(this.db, () => {
      const result = this.db.prepare('INSERT OR IGNORE INTO slack_relay (profile, delivery, sender, channel, ts, thread, text, received_at, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(this.profileId, message.delivery, message.sender, message.channel, message.ts, message.thread ?? null, message.text.slice(0, MAX_TEXT), new Date(this.now()).toISOString(), files);
      if (!result.changes) return false;
      this.stageReceipt(message);
      if (retire && this.poster) this.outbox.stage({ id: `retire:${message.delivery}`, channel: 'slack', kind: 'retire', payload: retire });
      return true;
    });
    if (!relayed) return 'duplicate';
    for (const arrived of [...this.arrivals]) arrived();
    this.schedule();
    return 'relayed';
  }

  /** Stages the automatic receipt for a DM or project-channel message when no reader has been present for a while. */
  private stageReceipt(message: QueuedMessage): void {
    const poster = this.poster;
    if (!poster || this.now() - this.lastRead <= READER_GRACE_MS) return;
    const destination = message.channel.startsWith('D') || message.channel === FORWARD_CHANNEL || message.channel === HOME_CHANNEL ? undefined : poster.nameOf(message.channel);
    if (destination === null) return;
    this.outbox.stage({ id: `receipt:${message.delivery}`, channel: 'slack', kind: 'receipt', payload: { text: OFFLINE_RECEIPT, thread: message.thread ?? message.ts, ...(destination ? { destination } : {}) } });
  }

  /** An outbound Slack write requested over the loopback API: its intent commits before the call (see `Outbox.perform`). */
  record<T>(kind: string, payload: unknown, run: () => Promise<T>): Promise<T> { return this.outbox.perform('slack', kind, payload, run); }

  /** Runs one dispatch pass; passes are serialized, and a pass schedules the next one when a retry comes due. */
  private schedule(): void { this.pending = this.pending.then(() => this.flush()).catch(() => undefined); }
  private async flush(): Promise<void> {
    const poster = this.poster;
    if (!poster) return;
    clearTimeout(this.retryTimer);
    await this.outbox.dispatch(row => this.deliver(poster, row));
    const next = this.outbox.nextDueAt();
    if (next !== null) { this.retryTimer = setTimeout(() => this.schedule(), Math.max(0, next - this.now())); this.retryTimer.unref(); }
  }
  private async deliver(poster: SlackPoster, row: OutboxRow): Promise<void> {
    const payload = row.payload as Record<string, string | undefined>;
    if (row.kind === 'receipt') { await poster.send(String(payload.text), payload.thread, payload.destination); return; }
    if (row.kind === 'retire') { await poster.update(String(payload.channel), String(payload.ts), String(payload.text)); return; }
    throw new OutboxRefused('unknown_outbox_kind');
  }

  /**
   * Messages after `seq`, oldest first, like `after`; when there are none, holds the read up to `waitMs` and answers as soon as
   * a message arrives. Nothing is polled in between: the arrival itself ends the wait.
   */
  async waitAfter(seq: number, limit: number, waitMs: number): Promise<RelayMessage[]> {
    const rows = this.after(seq, limit);
    if (rows.length || waitMs <= 0) return rows;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.arrivals.delete(done); resolve(); };
      const timer = setTimeout(done, waitMs);
      this.arrivals.add(done);
    });
    return this.after(seq, limit);
  }

  /** Messages after `seq`, oldest first. Reading marks a reader as present. */
  after(seq: number, limit: number): RelayMessage[] {
    this.lastRead = this.now();
    const rows = this.db.prepare('SELECT seq, sender, channel, ts, thread, text, received_at, files FROM slack_relay WHERE profile = ? AND seq > ? ORDER BY seq LIMIT ?').all(this.profileId, seq, limit) as Record<string, string | number | null>[];
    return rows.map(row => ({ seq: Number(row.seq), sender: String(row.sender), channel: String(row.channel), ts: String(row.ts), thread: row.thread === null ? null : String(row.thread), text: String(row.text), receivedAt: String(row.received_at), ...(row.files ? { files: JSON.parse(String(row.files)) as SlackFile[] } : {}) }));
  }

  /** Settles the running dispatch pass (tests, shutdown). */
  idle(): Promise<unknown> { return this.pending; }
  close(): void { clearTimeout(this.retryTimer); this.db.close(); }
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
/** App Home buttons, each queued as the DM text the operator could have typed (`optchat_home_approve` in the approval's thread). */
export const HOME_ACTIONS: Readonly<Record<string, 'status' | 'parar' | 'aprovar'>> = { optchat_home_status: 'status', optchat_home_stop: 'parar', optchat_home_approve: 'aprovar' };

/** The App Home: the text, then Status agora, Parar while working (with a confirm) and Aprovar when a call waits. */
export function homeBlocks(text: string, options: { working?: boolean; approval?: string } = {}): unknown[] {
  const button = (action_id: string, label: string, extra: Record<string, unknown> = {}) => ({ type: 'button', action_id, value: action_id, text: { type: 'plain_text', text: label }, ...extra });
  const elements = [
    ...options.approval ? [button('optchat_home_approve', 'Aprovar pendente', { style: 'primary', value: options.approval })] : [],
    button('optchat_home_status', 'Status agora'),
    ...options.working ? [button('optchat_home_stop', 'Parar', { style: 'danger', confirm: { title: { type: 'plain_text', text: 'Parar o trabalho?' }, text: { type: 'plain_text', text: 'Interrompe o que estou fazendo agora, como Esc no terminal.' }, confirm: { type: 'plain_text', text: 'Parar' }, deny: { type: 'plain_text', text: 'Continuar' } } })] : [],
  ];
  return [{ type: 'section', text: { type: 'mrkdwn', text } }, { type: 'actions', elements }];
}

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
    if (!destination) throw new OutboxRefused('unknown_channel');
    const chunks = parts(slackText(text));
    if (!chunks.length) throw new OutboxRefused('empty_message');
    const buttons = options.approval && chunks.length === 1 && chunks[0]!.length <= SECTION_MAX;
    let ts = '', posted: string | undefined;
    for (const [index, chunk] of chunks.entries()) {
      let body: { ts?: unknown; channel?: unknown };
      try { body = await this.call(POST_URL, { channel: destination, text: chunk, ...(buttons ? { blocks: approvalBlocks(chunk) } : {}), ...(threadTs ? { thread_ts: threadTs, ...(options.broadcast ? { reply_broadcast: true } : {}) } : {}), unfurl_links: false }); }
      // A later part that fails means earlier parts were posted: the whole send is uncertain, never a refusal to retry.
      catch (error) { throw index === 0 ? error : new Error('slack_partial_post'); }
      ts = typeof body.ts === 'string' ? body.ts : ts;
      posted = typeof body.channel === 'string' ? body.channel : posted;
    }
    return { parts: chunks.length, ts, ...(posted ? { channel: posted } : {}) };
  }

  /** Rewrites one of the bot's own DM posts as plain text, dropping its buttons. */
  async update(channel: string, ts: string, text: string): Promise<void> {
    if (!/^D[A-Z0-9]{2,20}$/.test(channel)) throw new OutboxRefused('unknown_channel');
    await this.call(UPDATE_URL, { channel, ts, text: slackText(text), blocks: [] });
  }

  /** Marks a message the operator wrote (DM or a configured channel) with an emoji: seen, done. */
  async react(channel: string, ts: string, name: string, remove = false): Promise<void> {
    if (!/^D[A-Z0-9]{2,20}$/.test(channel) && !Object.values(this.options.channels).includes(channel)) throw new OutboxRefused('unknown_channel');
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
  async publishHome(markdown: string, options: { working?: boolean; approval?: string } = {}): Promise<void> {
    const text = slackText(markdown).slice(0, SECTION_MAX);
    await this.call(`${API}views.publish`, { user_id: this.options.operator, view: { type: 'home', blocks: homeBlocks(text, options) } });
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
    // Slack answers ok:false before it posts or edits anything: a definite refusal, retryable only for its rate and outage codes.
    if (!body.ok) {
      const code = typeof body.error === 'string' ? body.error.replace(/[^\w.-]/g, '').slice(0, 60) : `http_${response.status}`;
      throw new OutboxRefused(`slack_${code}`, RETRYABLE_SLACK_ERRORS.has(code));
    }
    return body;
  }
}
