import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TaskStore } from '../store/db.ts';
import { admit, type ChannelLedger, type Received } from './inbound.ts';
import type { SlackRelay } from './slack-relay.ts';

const WINDOW_SECONDS = 300;
type Headers = Record<string, string | string[] | undefined>;
const header = (headers: Headers, name: string) => { const value = headers[name]; return typeof value === 'string' ? value : undefined; };

/** Slack v0 request signing over the exact raw body, within a 5-minute window. */
export function verifySlack(headers: Headers, rawBody: string, signingSecret: string, now: number): boolean {
  const ts = header(headers, 'x-slack-request-timestamp'); const signature = header(headers, 'x-slack-signature');
  if (!ts || !/^\d{1,12}$/.test(ts) || !signature || !signingSecret) return false;
  if (Math.abs(now / 1000 - Number(ts)) > WINDOW_SECONDS) return false;
  const expected = Buffer.from(`v0=${createHmac('sha256', signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex')}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type SlackOptions = {
  store: TaskStore; ledger: ChannelLedger; profileId: string; team: string; appId: string;
  /** Events API only; without it `receive` refuses every request and only `accept` (Socket Mode) admits. */
  signingSecret?: string;
  /** With a relay, operator DMs are a chat with the OptChat session instead of suggested tasks. */
  relay?: SlackRelay;
  now?: () => number; reviewLink: (taskId: string) => string;
};
// Edits, joins, bot posts and shares are not a person writing to the assistant now.
const NON_HUMAN_SUBTYPES = new Set(['bot_message', 'message_changed', 'message_deleted', 'channel_join', 'thread_broadcast', 'file_share', 'me_message']);

export class SlackChannel {
  private readonly options: SlackOptions & { now: () => number };
  constructor(options: SlackOptions) { this.options = { now: Date.now, ...options }; }
  /** Events API over HTTPS: the v0 signature authenticates the request. */
  receive(headers: Headers, rawBody: string): Received {
    if (!verifySlack(headers, rawBody, this.options.signingSecret ?? '', this.options.now())) return { outcome: 'unauthenticated' };
    let body: unknown;
    try { body = JSON.parse(rawBody); } catch { return { outcome: 'ignored' }; }
    return this.accept(body);
  }

  /**
   * A payload whose origin the transport already authenticated: a signed HTTPS request, or a Socket Mode envelope
   * received on the connection opened with this app's token. Workspace and app are still checked.
   */
  accept(payload: unknown): Received {
    const o = this.options;
    if (!payload || typeof payload !== 'object') return { outcome: 'ignored' };
    const body = payload as Record<string, any>;
    if (body.type === 'block_actions') {
      if (body.team?.id !== o.team || body.api_app_id !== o.appId) return { outcome: 'foreign_workspace' };
      // A button is a remote click, not the operator's authenticated review of the exact effect.
      const taskId = typeof body.actions?.[0]?.value === 'string' ? body.actions[0].value : '';
      return { outcome: 'review_required', reply: `Revise no painel autenticado: ${o.reviewLink(taskId)}` };
    }
    if (body?.type !== 'event_callback' || body.event?.type !== 'message') return { outcome: 'ignored' };
    if (body.team_id !== o.team || body.api_app_id !== o.appId) return { outcome: 'foreign_workspace' };
    const event = body.event;
    if (typeof body.event_id !== 'string' || typeof event.channel !== 'string' || typeof event.ts !== 'string') return { outcome: 'ignored' };
    const human = !event.bot_id && !NON_HUMAN_SUBTYPES.has(event.subtype) && typeof event.user === 'string';
    if (o.relay && event.channel.startsWith('D')) return this.relay(o.relay, body.event_id, event, human);
    return admit({
      platform: 'slack', account: o.team, delivery: body.event_id, sender: typeof event.user === 'string' ? event.user : '',
      human,
      conversation: event.channel, messageId: event.ts, ...(typeof event.thread_ts === 'string' && event.thread_ts !== event.ts ? { thread: event.thread_ts } : {}),
      text: typeof event.text === 'string' ? event.text : '',
    }, o);
  }

  /** An operator DM for the chat session: same sender and human checks as a task, queued instead of created. */
  private relay(relay: SlackRelay, delivery: string, event: Record<string, any>, human: boolean): Received {
    if (!human) return { outcome: 'ignored_not_human' };
    if (!this.options.ledger.authorized('slack', this.options.team, event.user)) return { outcome: 'unauthorized_sender' };
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text) return { outcome: 'ignored' };
    const thread = typeof event.thread_ts === 'string' && event.thread_ts !== event.ts ? { thread: event.thread_ts } : {};
    return { outcome: relay.enqueue({ delivery, sender: event.user, channel: event.channel, ts: event.ts, ...thread, text }) };
  }
}
