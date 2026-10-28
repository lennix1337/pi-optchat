import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TaskStore } from '../store/db.ts';
import { admit, type ChannelLedger, type Received } from './inbound.ts';

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
  store: TaskStore; ledger: ChannelLedger; profileId: string; team: string; appId: string; signingSecret: string;
  now?: () => number; reviewLink: (taskId: string) => string;
};
// Edits, joins, bot posts and shares are not a person writing to the assistant now.
const NON_HUMAN_SUBTYPES = new Set(['bot_message', 'message_changed', 'message_deleted', 'channel_join', 'thread_broadcast', 'file_share', 'me_message']);

export class SlackChannel {
  private readonly options: SlackOptions & { now: () => number };
  constructor(options: SlackOptions) { this.options = { now: Date.now, ...options }; }
  receive(headers: Headers, rawBody: string): Received {
    const o = this.options;
    if (!verifySlack(headers, rawBody, o.signingSecret, o.now())) return { outcome: 'unauthenticated' };
    let body: Record<string, any>;
    try { body = JSON.parse(rawBody); } catch { return { outcome: 'ignored' }; }
    if (body?.type === 'block_actions') {
      if (body.team?.id !== o.team || body.api_app_id !== o.appId) return { outcome: 'foreign_workspace' };
      // A button is a remote click, not the operator's authenticated review of the exact effect.
      const taskId = typeof body.actions?.[0]?.value === 'string' ? body.actions[0].value : '';
      return { outcome: 'review_required', reply: `Revise no painel autenticado: ${o.reviewLink(taskId)}` };
    }
    if (body?.type !== 'event_callback' || body.event?.type !== 'message') return { outcome: 'ignored' };
    if (body.team_id !== o.team || body.api_app_id !== o.appId) return { outcome: 'foreign_workspace' };
    const event = body.event;
    if (typeof body.event_id !== 'string' || typeof event.channel !== 'string' || typeof event.ts !== 'string') return { outcome: 'ignored' };
    return admit({
      platform: 'slack', account: o.team, delivery: body.event_id, sender: typeof event.user === 'string' ? event.user : '',
      human: !event.bot_id && !NON_HUMAN_SUBTYPES.has(event.subtype) && typeof event.user === 'string',
      conversation: event.channel, messageId: event.ts, ...(typeof event.thread_ts === 'string' && event.thread_ts !== event.ts ? { thread: event.thread_ts } : {}),
      text: typeof event.text === 'string' ? event.text : '',
    }, o);
  }
}
