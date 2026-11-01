import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { assistantConfig, assistantRequest, HttpError } from './assistant-client.ts';
import type { Settled } from './authorization.ts';
import { promptText, wakeTask } from './heartbeat.ts';
import { recordAnswer, recordInbound } from './slack-metrics.ts';
import { delivers, projectOf, toolCalls } from './projects.ts';
import { failoverReader, homeStatus, remoteCommand, type CommandState, type ModelRef } from './remote-commands.ts';
import { randomUUID } from 'node:crypto';
import { QUOTA_FILE } from './quota-health.ts';
import { atomicWrite } from './store.ts';
import { textContent } from './transcript.ts';

/**
 * The operator's Slack DM as a second door into this chat. The assistant service queues the operator's DMs; this
 * bridge polls them over the loopback API, hands each to the agent as a user message marked `[Slack]`, and posts the
 * run's final answer back to the DM. `slack_send` lets the agent write first (progress, finished work, a blocker).
 * A heartbeat wake that delivered something (an edit, commit, push or PR) posts its final answer to that repo's channel.
 * Pi marks these messages as extension input, so a Slack message never approves a gated effect by itself. The one
 * exception is an approval post (`askApproval`): the operator's `aprovar` or `negar` in that post's DM thread decides
 * that one pending call. The service queues only human messages from the configured operator, and Slack signs them, so
 * the agent cannot write such a reply.
 */
export const SLACK_PREFIX = '[Slack] ';
/** `[Slack] ` for the DM, `[Slack #dentai] ` for a project channel. */
const slackPrefix = (channel: string | null) => channel ? `[Slack #${channel}] ` : SLACK_PREFIX;
export const FROM_SLACK = /^\[Slack(?: #([a-z0-9][a-z0-9_-]{0,79}))?\] /;
export type SlackOwner = { dir: string; name: string };
type SlackFile = { id: string; name: string; mimetype: string; url: string };
type Inbound = { seq: number; ts: string; thread: string | null; text: string; channel?: string; channelName?: string | null; files?: SlackFile[] };
/** Where a Slack message came from: `channel` is the configured name (null = DM), `id`/`ts` the message itself for reactions. */
type Origin = { thread: string | null; channel: string | null; id?: string; ts?: string; threaded?: boolean };
const REAL_CHANNEL = /^[CDG][A-Z0-9]{2,20}$/;
/** A Slack message link pasted in a message: https://x.slack.com/archives/C123/p1793000000123456 */
const SLACK_LINK = /https:\/\/[\w-]+\.slack\.com\/archives\/([CDG][A-Z0-9]{2,20})\/p(\d{10})(\d{6})(?:\?[^\s>|]*thread_ts=(\d{10}\.\d{6}))?/g;
const SEEN = 'eyes', DONE = 'white_check_mark';
type Request = (owner: SlackOwner, path: string, body?: unknown) => Promise<unknown>;
const CURSOR = 'slack-cursor.json';
const OFF_FOR_MS = 5 * 60_000;
/** How long a remote command that needs approval (an account switch) waits for the tap. */
const COMMAND_APPROVAL_MS = 10 * 60_000;
const EMPTY_RUN = 'Recebi, mas a execução terminou sem resposta em texto (erro ou interrupção). Manda de novo se precisar.';
/** A DM steered into a working run: a text-only reply would end the run and stop the work. */
const MID_RUN = '\n\n(Arrived while you were working: answer it with slack_send, then continue the current work. Do not end the run just to reply.)';

const defaultRequest: Request = async (owner, path, body) => assistantRequest(assistantConfig(owner), path, body, 20_000);
const APPROVE = /^(?:aprovar|aprova|aprovado|sim|ok|approve)[.!]?$/i;
const DENY = /^(?:negar|nega|negado|n[aã]o|deny)[.!]?$/i;
/** A gated call waiting for the operator, and how to decide it. */
export type ApprovalRequest = { token: string; summary: string; label: string; expires: number; decide: (approve: boolean) => boolean;
  /** An effect the bridge itself runs on the phone's decision (a remote command); its answer replaces the note to the agent. */
  onPhone?: (approve: boolean) => Promise<string> };
/** What an approval post says once the call stopped waiting, so it never stays "pendente" with live buttons. */
const SETTLED_TEXT: Record<Settled | 'phone-approved' | 'phone-denied', string> = {
  approved: '\u2705 *Aprovado no terminal*', denied: '\u{1f6ab} *Negado no terminal*', superseded: '\u21aa\ufe0f *Substitu\u00edda por uma chamada mais nova*',
  expired: '\u231b *Expirou sem decis\u00e3o*', 'phone-approved': '\u2705 *Aprovado no Slack*', 'phone-denied': '\u{1f6ab} *Negado no Slack*',
};
type Post = { request: ApprovalRequest; channel: string | null };
const TOPICS = 'slack-threads.json';
const TOPIC_DAYS = 14;

/**
 * Where a wake's result belongs: the channel of the repository its delivering calls touched most, or the DM when they
 * touched none of the mapped repositories. `undefined` when the wake delivered nothing (or already reported itself with
 * slack_send): an empty wake posts nothing.
 */
const clock = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

export function wakeChannel(messages: readonly AgentMessage[]): string | null | undefined {
  const calls = toolCalls(messages);
  if (calls.some(c => c.name === 'slack_send')) return undefined;
  const delivering = calls.filter(delivers);
  if (!delivering.length) return undefined;
  return projectOf(...delivering.map(call => JSON.stringify(call.arguments))) ?? null;
}

function finalText(messages: readonly AgentMessage[]): string {
  const last = [...messages].reverse().find(m => m.role === 'assistant');
  return last ? textContent(last.content, false).trim() : '';
}

export class SlackBridge {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private pollFailure: string | undefined;
  private offUntil = 0;
  /** Set when a `[Slack]` message entered the current run: its final answer goes back to the DM. */
  private answering: Origin | undefined;
  /** Set when a heartbeat wake started the current run: what it delivered is reported to the repo's channel. */
  private waking = false;
  private running = false;
  private readonly threads = new Map<string, Origin>();
  /** Approval posts by their DM ts, until decided or expired. */
  private readonly approvals = new Map<string, Post>();
  /** Rewrites of decided approval posts, in order. */
  private settling: Promise<unknown> = Promise.resolve();
  private readonly options: { intervalMs: number; now: () => number; request: Request; warn: (text: string) => void; sent: (channel: string | null, text: string) => void;
    schedule: (run: () => void, ms: number) => void;
    /** Whether the chat can take a DM now. While not, the inbox is left alone: a message handed to a chat that drops it would still move the cursor. */
    accepting: () => boolean;
    /** The selected model (`provider/id`) and pi-multi-account's state, for the commands answered without a turn and the App Home. */
    model: () => string | undefined; failover: () => unknown;
    models: () => readonly ModelRef[]; select: (model: ModelRef) => Promise<boolean> };
  /** First line of the App Home: what the agent is doing now. */
  private activity = '\u2705 *Livre*';

  constructor(private readonly pi: Pick<ExtensionAPI, 'sendUserMessage'>, private readonly owner: () => SlackOwner | undefined,
    options: Partial<SlackBridge['options']> = {}) {
    this.options = { intervalMs: 3000, now: Date.now, request: defaultRequest, warn: () => {}, sent: () => {}, schedule: (run, ms) => { setTimeout(run, ms).unref?.(); }, accepting: () => true, model: () => undefined, failover: failoverReader(QUOTA_FILE),
      models: () => [], select: async () => false, ...options };
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.poll().then(() => { this.pollFailure = undefined; }, error => this.pollFailed(error)), this.options.intervalMs);
    this.timer.unref?.();
  }
  /** A pass that throws (the cursor cannot be written, the chat refuses the message) is retried at the next interval; it must not escape as an unhandled rejection, and a repeat of the same failure is said once. */
  private pollFailed(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error);
    if (text === this.pollFailure) return;
    this.pollFailure = text;
    this.options.warn(`Slack inbox pass failed; it retries: ${text}`);
  }
  stop(): void { clearInterval(this.timer); this.answering = undefined; this.waking = false; this.running = false; }
  runStarted(): void { this.running = true; }

  /** One pass: new DMs become user messages in order; the cursor advances only past delivered ones. */
  async poll(): Promise<number> {
    const owner = this.owner();
    if (!owner || this.polling || !this.options.accepting() || this.options.now() < this.offUntil) return 0;
    this.polling = true;
    try {
      const seq = this.cursor(owner);
      let value: unknown;
      try { value = await this.options.request(owner, `/v1/slack/inbox?after=${seq}&limit=20`); }
      catch (error) {
        // No assistant.json, service down, or no bot token configured (404): try again later, quietly.
        if (!(error instanceof HttpError) || error.status !== 404) this.offUntil = this.options.now() + OFF_FOR_MS / 10;
        else this.offUntil = this.options.now() + OFF_FOR_MS;
        return 0;
      }
      const messages = (value as { messages?: Inbound[] })?.messages;
      if (!Array.isArray(messages)) return 0;
      let delivered = 0;
      for (const m of messages) {
        if (!Number.isSafeInteger(m.seq) || m.seq <= seq || typeof m.text !== 'string') continue;
        const channel = typeof m.channelName === 'string' ? m.channelName : null;
        if (!channel && typeof m.thread === 'string' && this.approvals.has(m.thread) && (APPROVE.test(m.text.trim()) || DENY.test(m.text.trim()))) {
          await this.decided(m.thread, APPROVE.test(m.text.trim()));
          atomicWrite(join(owner.dir, CURSOR), JSON.stringify({ seq: m.seq }));
          continue;
        }
        const command = channel ? undefined : remoteCommand(m.text);
        if (command) {
          // Answered here, at no model cost and even mid-run; the agent never sees it.
          try { await this.command(command); }
          catch (error) { this.options.warn(`Slack command "${command.command.name}" not answered: ${error instanceof Error ? error.message : String(error)}`); }
          atomicWrite(join(owner.dir, CURSOR), JSON.stringify({ seq: m.seq }));
          continue;
        }
        const id = typeof m.channel === 'string' && REAL_CHANNEL.test(m.channel) ? m.channel : undefined;
        if (id) this.react(owner, id, m.ts, SEEN);
        const extras = await this.enrich(owner, m);
        const text = `${slackPrefix(channel)}${m.text}${extras}${this.running ? MID_RUN : ''}`;
        this.threads.set(text, { thread: typeof m.thread === 'string' ? m.thread : null, channel, ...(id ? { id, ts: m.ts } : {}) });
        this.pi.sendUserMessage(text, { deliverAs: 'steer' });
        atomicWrite(join(owner.dir, CURSOR), JSON.stringify({ seq: m.seq }));
        this.measure(dir => recordInbound(dir, channel, m.text, this.options.now()));
        delivered++;
      }
      return delivered;
    } finally { this.polling = false; }
  }

  /**
   * What a message carries besides its text: the files the operator sent (saved locally, so the agent can look at an
   * image or transcribe an audio) and the Slack messages he linked (read by the bot). Each part is best effort and says
   * why when it fails, so the agent never answers as if it had seen something it did not.
   */
  private async enrich(owner: SlackOwner, m: Inbound): Promise<string> {
    const lines: string[] = [];
    for (const file of Array.isArray(m.files) ? m.files : []) {
      try {
        const { path } = await this.options.request(owner, '/v1/slack/download', { url: file.url, name: file.name }) as { path: string };
        const hint = file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/') ? ' (transcreva com transcribe_file)' : file.mimetype.startsWith('image/') ? ' (veja com read)' : '';
        lines.push(`- ${file.name} [${file.mimetype}]: ${path}${hint}`);
      } catch (error) { lines.push(`- ${file.name} [${file.mimetype}]: não baixou (${error instanceof Error ? error.message : String(error)})`); }
    }
    const files = lines.length ? `\n\nAnexos:\n${lines.join('\n')}` : '';
    const quotes: string[] = [];
    for (const [, channel, sec, frac, thread] of [...m.text.matchAll(SLACK_LINK)].slice(0, 3)) {
      const ts = `${sec}.${frac}`;
      try {
        const found = await this.options.request(owner, '/v1/slack/fetch', { channel, ts, thread: thread ?? ts }) as { user: string; text: string };
        quotes.push(`Mensagem linkada (<@${found.user}> em <#${channel}>):\n${found.text.split('\n').map(line => `> ${line}`).join('\n')}`);
      } catch (error) { quotes.push(`Mensagem linkada em <#${channel}>: não consegui ler (${error instanceof Error ? error.message : String(error)}; o bot precisa estar no canal).`); }
    }
    return files + (quotes.length ? `\n\n${quotes.join('\n\n')}` : '');
  }

  /** An emoji on the operator's message: 👀 when it reached the chat, ✅ when the answer went out. Never blocks. */
  private react(owner: SlackOwner, channel: string, ts: string, name: string, remove = false): void {
    void this.options.request(owner, '/v1/slack/react', { channel, ts, name, remove }).catch(() => undefined);
  }

  /** The operator's App Home in Slack shows what the assistant is doing right now. Never blocks. */
  private home(text: string): void {
    const owner = this.owner();
    this.activity = text.split('\n')[0]!;
    let status = '';
    try { status = `\n\n${homeStatus(this.commandState())}`; } catch { /* the activity line still goes out */ }
    if (owner) void this.options.request(owner, '/v1/slack/home', { text: `${text.slice(0, 2900 - status.length)}${status}` }).catch(() => undefined);
  }

  /** What the remote commands read: the live model and activity, and pi-multi-account's cached quota. */
  commandState(): CommandState {
    const { model, failover, now, models, select } = this.options;
    return { model, activity: () => this.activity, failover, now, models, select };
  }

  /** Answers a remote command in the DM; an effect it asks to confirm goes out as an approval post first. */
  private async command({ command, arg }: NonNullable<ReturnType<typeof remoteCommand>>): Promise<void> {
    const result = await command.run(this.commandState(), arg);
    if (!result.confirm) { await this.send(result.text); this.answered(null); return; }
    const { summary, apply } = result.confirm;
    let ran = false;
    await this.askApproval({
      token: `cmd-${randomUUID()}`, label: `Comando *${command.name}*`, summary: `${result.text} ${summary}`.slice(0, 500), expires: this.options.now() + COMMAND_APPROVAL_MS,
      decide: () => !ran && (ran = true),
      onPhone: async approve => approve ? apply() : `Negado: continuo em ${this.options.model() ?? 'nenhum modelo'}.`,
    });
  }

  /** Called for every user message of a run; a `[Slack]` one makes this run answer where it came from. */
  sawUserMessage(text: string): void {
    if (wakeTask(text) !== undefined) { this.waking = true; this.home(`\u{1f504} *Trabalhando* (turno automático) desde ${clock(this.options.now())}`); return; }
    const match = FROM_SLACK.exec(text);
    const about = text.replace(FROM_SLACK, '').replace(MID_RUN, '').split('\n')[0]!.slice(0, 300);
    if (!this.running || match) this.home(`\u{1f504} *Trabalhando* desde ${clock(this.options.now())}\n> ${about}`);
    if (!match) return;
    this.answering = this.threads.get(text) ?? { thread: null, channel: match[1] ?? null };
    this.threads.delete(text);
  }

  /**
   * A progress post of the run that answers a Slack message, to that same place and without a topic, goes in the thread
   * of the operator's message, so a long task keeps its history together; the final answer then closes that thread.
   */
  progressThread(channel: string | null): string | null {
    const origin = this.answering;
    if (!origin || origin.channel !== channel) return null;
    const thread = origin.thread ?? (origin.channel === null || origin.id ? origin.ts ?? null : null);
    if (thread) origin.threaded = true;
    return thread;
  }

  /** At the end of a run that received a Slack message, its final answer goes back to the DM. */
  async runEnded(messages: readonly AgentMessage[]): Promise<void> {
    const answering = this.answering, waking = this.waking;
    this.answering = undefined; this.waking = false;
    this.running = false;
    const last = finalText(messages);
    this.home(`\u2705 *Livre* desde ${clock(this.options.now())}${last ? `\n\u00daltima resposta:\n${last.slice(0, 1500)}` : ''}`);
    if (answering) {
      // After progress in the thread, the answer closes it and also shows in the conversation.
      const thread = answering.threaded ? answering.thread ?? answering.ts ?? null : answering.thread;
      try {
        await this.send(last || EMPTY_RUN, thread, answering.channel, answering.threaded && !answering.thread ? { broadcast: true } : {});
        this.answered(answering.channel);
        const owner = this.owner();
        if (owner && answering.id && answering.ts) { this.react(owner, answering.id, answering.ts, SEEN, true); this.react(owner, answering.id, answering.ts, DONE); }
      }
      catch (error) { this.options.warn(`Slack reply not sent: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    const text = waking && finalText(messages);
    const channel = text ? wakeChannel(messages) : undefined;
    if (!text || channel === undefined) return;
    try { await this.send(`*Wake* · ${text}`, null, channel); }
    catch (error) { this.options.warn(`Wake report not sent to Slack: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Posts a gated call to the operator's DM with Aprovar/Negar buttons; a tap (relayed by the service as that reply) or
   * their `aprovar`/`negar` in its thread decides it. Best effort: the terminal `/approve` keeps working when Slack is down.
   */
  async askApproval(request: ApprovalRequest): Promise<void> {
    const now = this.options.now();
    for (const [ts, post] of this.approvals) if (post.request.expires <= now) this.approvals.delete(ts);
    const minutes = Math.max(1, Math.round((request.expires - now) / 60_000));
    const head = `⏸ *Aprovação pendente* · ${request.label}: ${request.summary}\n`, tail = `(vale ${minutes} min). Aprova só esta chamada, uma vez.`;
    try {
      let ts: string, channel: string | undefined;
      try { ({ ts, channel } = await this.send(`${head}Toque em *Aprovar* ou *Negar*, ou responda *aprovar*/*negar* nesta thread ${tail}`, null, null, { approval: true })); }
      catch (error) {
        // A service from before the buttons refuses the field: the thread reply still decides.
        if (!(error instanceof Error && /HTTP 400/.test(error.message))) throw error;
        ({ ts, channel } = await this.send(`${head}Responda *aprovar* ou *negar* nesta thread ${tail}`));
      }
      this.approvals.set(ts, { request, channel: typeof channel === 'string' ? channel : null });
      this.options.schedule(() => void this.settled(request.token, 'expired'), Math.max(0, request.expires - now));
    } catch (error) { this.options.warn(`Approval not posted to Slack: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** The call of an approval post stopped waiting outside Slack (terminal, a newer call, expiry): the post says so. */
  settled(token: string, outcome: Settled): Promise<unknown> {
    const found = [...this.approvals].find(([, post]) => post.request.token === token);
    if (!found) return this.settling;
    this.approvals.delete(found[0]);
    return this.retire(found[0], found[1], outcome);
  }

  /** Settles pending post rewrites (tests). */
  idle(): Promise<unknown> { return this.settling; }

  /** Rewrites the post without its buttons; a service without `update` (or a post without its DM id) gets a thread reply. */
  private retire(ts: string, { request, channel }: Post, outcome: keyof typeof SETTLED_TEXT): Promise<unknown> {
    const text = `${SETTLED_TEXT[outcome]} \u00b7 ${request.label}: ${request.summary}`;
    const owner = this.owner();
    this.settling = this.settling.then(async () => {
      try {
        if (!owner || !channel) throw new Error('no DM id');
        await this.options.request(owner, '/v1/slack/update', { channel, ts, text });
      } catch {
        try { await this.send(text, ts); }
        catch (error) { this.options.warn(`Approval post not updated on Slack: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
    return this.settling;
  }

  private async decided(ts: string, approve: boolean): Promise<void> {
    const post = this.approvals.get(ts)!, { request } = post;
    this.approvals.delete(ts);
    const done = request.expires > this.options.now() && request.decide(approve);
    if (done) await this.retire(ts, post, approve ? 'phone-approved' : 'phone-denied');
    if (done && request.onPhone) {
      let reply: string;
      try { reply = await request.onPhone(approve); } catch (error) { reply = `Falhou: ${error instanceof Error ? error.message : String(error)}`; }
      try { await this.send(reply, ts); } catch { /* the effect stands; the reply is a courtesy */ }
      return;
    }
    const reply = !done ? 'Essa aprovação já expirou ou foi decidida; nada rodou por ela.' : approve ? `Aprovado: ${request.summary}. Vou rodar agora.` : `Negado: ${request.summary}. Não vou rodar.`;
    try { await this.send(reply, ts); } catch { /* the decision stands; the reply is a courtesy */ }
    if (!done) return;
    const note = approve ? `aprovou no celular: ${request.summary}. Rode de novo exatamente a mesma chamada, uma vez.` : `negou no celular: ${request.summary}. Não rode nem tente de novo.`;
    this.pi.sendUserMessage(`${SLACK_PREFIX}(aprovação) O operador ${note}`, { deliverAs: 'steer' });
  }

  /**
   * Posts under a topic: the first post of a `topic` opens a message in the channel, later ones reply in its thread,
   * so one subject (a PR, a long task) keeps its history together. Topics last two weeks.
   */
  async post(text: string, channel: string | null, topic?: string): Promise<{ parts: number; ts: string }> {
    const owner = this.owner();
    if (!topic || !owner) return this.send(text, this.progressThread(channel), channel);
    const file = join(owner.dir, TOPICS), now = this.options.now();
    let topics: Record<string, { channel: string | null; ts: string; at: number }> = {};
    try { topics = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
    const known = topics[topic];
    const open = known && known.channel === channel && now - known.at < TOPIC_DAYS * 86_400_000 ? known : undefined;
    const result = await this.send(text, open?.ts ?? null, channel);
    if (!open) {
      topics[topic] = { channel, ts: result.ts, at: now };
      const fresh = Object.entries(topics).filter(([, t]) => now - t.at < TOPIC_DAYS * 86_400_000).slice(-300);
      atomicWrite(file, JSON.stringify(Object.fromEntries(fresh)));
    }
    return result;
  }

  /** To the operator's DM, or with `channel` to that configured project channel. */
  async send(text: string, threadTs: string | null = null, channel: string | null = null, options: { approval?: true; broadcast?: true } = {}): Promise<{ parts: number; ts: string; channel?: string }> {
    const owner = this.owner();
    if (!owner) throw new Error('No active profile.');
    try {
      const result = await this.options.request(owner, '/v1/slack/send', { text, threadTs, ...(channel ? { channel } : {}), ...options }) as { parts: number; ts: string; channel?: string };
      this.options.sent(channel, text);
      return result;
    }
    catch (error) {
      if (error instanceof HttpError) throw new Error(error.status === 404 ? 'The assistant service has no Slack chat (no bot token configured).' : error.status === 503 ? 'Slack bot token not configured.' : error.status === 400 && channel ? `Unknown Slack channel "${channel}": it is not in the service's slack.channels.` : `Slack send failed (HTTP ${error.status}).`);
      throw error;
    }
  }

  /** An answer the operator received in `channel` (a run's final answer, or a slack_send), for the scoreboard. */
  answered(channel: string | null): void { this.measure(dir => recordAnswer(dir, channel, this.options.now())); }

  /** The scoreboard's log never gets in the way of a message. */
  private measure(write: (dir: string) => void): void {
    const owner = this.owner();
    try { if (owner) write(owner.dir); } catch (error) { this.options.warn(`Slack metrics not recorded: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private cursor(owner: SlackOwner): number {
    try { const seq = (JSON.parse(readFileSync(join(owner.dir, CURSOR), 'utf8')) as { seq?: unknown }).seq; return Number.isSafeInteger(seq) ? seq as number : 0; }
    catch { return 0; }
  }
}

/** Wires the bridge into Pi: polling per session, replies at run end, and the `slack_send` tool. */
export function registerSlackBridge(pi: ExtensionAPI, owner: () => SlackOwner | undefined, sent: (channel: string | null, text: string) => void = () => {},
  options: { request?: Request; accepting?: () => boolean } = {}): SlackBridge {
  let warn: (text: string) => void = () => {};
  let model: string | undefined;
  const named = (m: { provider: string; id: string } | undefined) => m ? `${m.provider}/${m.id}` : undefined;
  let registry: { getAvailable(): readonly ModelRef[]; find(provider: string, id: string): unknown } | undefined;
  const bridge = new SlackBridge(pi, owner, {
    warn: text => warn(text), sent, model: () => model,
    models: () => registry?.getAvailable().map(m => ({ provider: m.provider, id: m.id })) ?? [],
    // Through Pi, like `/model`: pi-multi-account sees an ordinary user switch.
    select: async ({ provider, id }) => { const found = registry?.find(provider, id); return found ? pi.setModel(found as never) : false; },
    ...options,
  });
  pi.on('session_start', (_event, ctx) => { warn = text => ctx.ui.notify(text, 'warning'); model = named(ctx.model); registry = ctx.modelRegistry; bridge.start(); });
  // pi-multi-account switches by selecting the other account's model, so this follows its failovers too.
  pi.on('model_select', event => { model = named(event.model); });
  pi.on('session_shutdown', () => bridge.stop());
  pi.on('message_end', ({ message }) => { const text = promptText(message); if (text !== undefined) bridge.sawUserMessage(text); });
  pi.on('agent_start', () => bridge.runStarted());
  pi.on('agent_end', event => bridge.runEnded(event.messages));
  pi.registerTool({
    name: 'slack_send', label: 'Message the operator on Slack',
    description: "Send a message to the operator on Slack; they read it on the phone. Use it to report finished work, progress on long tasks and blockers that need their decision, especially when they may be away; never post shell or subagent completions (commands, exit codes, test output), only what the work delivered. `channel` posts to a project channel instead of the DM: dentai (dentai-mono), genexus18mcp (Genexus18MCP), harness (pi-optchat, pi-subagents, pi-goal-x, pi-multi-account, pi-ripwire, dotfiles); route reports by the repo the work is in, and keep the DM for general matters, urgent blockers and decisions. A [Slack] or [Slack #channel] message that arrives while you are working: answer it here (same channel) and keep working, since a text-only reply ends the run. When the run started from a Slack message, its final answer goes back automatically: don't repeat it here.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 20000 }),
      channel: Type.Optional(Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,79}$', description: 'Project channel name without #; omit for the DM.' })),
      topic: Type.Optional(Type.String({ pattern: '^[\\w.#:/-]{1,80}$', description: 'Short key of the task this post belongs to (e.g. denta-106, gx-issue-701). The first post with a topic opens it; later posts with the same topic reply in its thread.' })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const result = await bridge.post(params.text, params.channel ?? null, params.topic);
      bridge.answered(params.channel ?? null);
      return { content: [{ type: 'text', text: `Sent to ${params.channel ? `Slack #${params.channel}` : "the operator's Slack DM"} (${result.parts} part${result.parts === 1 ? '' : 's'}).` }], details: undefined };
    },
  });
  return bridge;
}
