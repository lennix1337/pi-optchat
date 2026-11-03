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
import { readDay, recordRun, renderDay } from './home-day.ts';
import { failoverReader, homeStatus, remoteCommand, type CommandState, type ModelRef } from './remote-commands.ts';
import { randomUUID } from 'node:crypto';
import { QUOTA_FILE } from './quota-health.ts';
import { atomicWrite } from './store.ts';
import { textContent } from './transcript.ts';
import { budgetNote, fitPost, wordBudget, type WordBudgets } from './slack-policy.ts';
import { backgroundSummary, NO_WORK, renderWorkParts, type HomeWork } from './home-items.ts';
import type { WaitingItem } from './commitments.ts';

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
/** Files of one message read at a time at most: a message can carry many, and each read is a round trip to the service. */
const FILE_READS = 4;
/** A Slack message link pasted in a message: https://x.slack.com/archives/C123/p1793000000123456 */
const SLACK_LINK = /https:\/\/[\w-]+\.slack\.com\/archives\/([CDG][A-Z0-9]{2,20})\/p(\d{10})(\d{6})(?:\?[^\s>|]*thread_ts=(\d{10}\.\d{6}))?/g;
const SEEN = 'eyes', DONE = 'white_check_mark';
type Request = (owner: SlackOwner, path: string, body?: unknown, cancel?: AbortSignal) => Promise<unknown>;
const CURSOR = 'slack-cursor.json';
const OFF_FOR_MS = 5 * 60_000;
/** The inbox read is held by the service up to this long (a message ends it at once); the service caps it at 15 s. */
const LONG_POLL_MS = 15_000;
/** A read the service held at least this long is followed at once; a faster empty answer waits for the interval. */
const HELD_MS = 1_000;
/** How long a remote command that needs approval (an account switch) waits for the tap. */
const COMMAND_APPROVAL_MS = 10 * 60_000;
const EMPTY_RUN = 'Recebi, mas a execução terminou sem resposta em texto (erro ou interrupção). Manda de novo se precisar.';
/** A DM steered into a working run: a text-only reply would end the run and stop the work. */
const MID_RUN = '\n\n(Arrived while you were working: answer it with slack_send, then continue the current work. Do not end the run just to reply.)';

const defaultRequest: Request = async (owner, path, body, cancel) => assistantRequest(assistantConfig(owner), path, body, 20_000, cancel);
const APPROVE = /^(?:aprovar|aprova|aprovado|sim|ok|approve)[.!]?$/i;
const DENY = /^(?:negar|nega|negado|n[aã]o|deny)[.!]?$/i;
/** A gated call waiting for the operator, and how to decide it. */
export type ApprovalRequest = { token: string; summary: string; label: string; expires: number; decide: (approve: boolean) => boolean;
  /** An effect the bridge itself runs on the phone's decision (a remote command); its answer replaces the note to the agent. */
  onPhone?: (approve: boolean) => Promise<string> };
/** What an approval post says once the call stopped waiting, so it never stays "pendente" with live buttons. */
const SETTLED_TEXT: Record<Settled | 'phone-approved' | 'phone-denied', string> = {
  approved: '\u2705 *Aprovado no terminal*', denied: '\u{1f6ab} *Negado no terminal*', superseded: '\u21aa\ufe0f *Substitu\u00edda por uma chamada mais nova*',
  expired: '\u231b *Expirou sem decis\u00e3o*', withdrawn: '\u21a9\ufe0f *Retirado: resolvi por outro caminho, sem precisar de aprova\u00e7\u00e3o*', 'phone-approved': '\u2705 *Aprovado no Slack*', 'phone-denied': '\u{1f6ab} *Negado no Slack*',
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

const HOME_STEP_MS = 20_000;
/** The Home's text budget; the service splits it into Slack sections. */
const HOME_CHARS = 11_000;
const IDLE = /^\u2705 \*Livre\*/;
/** What the service queues for the Home's Ver tudo / Ver menos buttons (assistant/src/channels/slack-relay.ts HOME_ACTIONS). */
const HOME_FOLD = { channel: 'home', more: 'tudo', less: 'menos' } as const;
/** At most `max` characters, cut at a word and marked with \u2026, so a quote or a link is never cut in half silently. */
export function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '';
  const cut = text.slice(0, max - 1), space = cut.search(/\s\S*$/);
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}
const base = (path: unknown) => typeof path === 'string' ? path.split(/[\\/]/).pop() ?? path : '';

/** Runs `run` on every item, at most `limit` at a time; results keep the input order. `run` must not throw. */
async function mapBounded<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; out[index] = await run(items[index]!); }
  }));
  return out;
}

/** A step in words, without arguments that could carry secrets: the program a shell ran, the file a tool touched. */
export function stepLabel(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === 'bash' && typeof a.command === 'string') {
    const part = a.command.split(/&&|;|\|\||\n/).map(s => s.trim()).find(s => s && !/^cd\s/.test(s)) ?? '';
    return `rodando \`${part.split(/\s+/).filter(w => !w.startsWith('-')).slice(0, 2).join(' ').slice(0, 40)}\``;
  }
  if (tool === 'read') return `lendo ${base(a.path)}`;
  if (tool === 'edit' || tool === 'write') return `editando ${base(a.path)}`;
  return `usando ${tool}`;
}

export function wakeChannel(messages: readonly AgentMessage[]): string | null | undefined {
  const calls = toolCalls(messages);
  if (calls.some(c => c.name === 'slack_send')) return undefined;
  const delivering = calls.filter(delivers);
  if (!delivering.length) return undefined;
  return projectOf(...delivering.map(call => JSON.stringify(call.arguments))) ?? null;
}

export function finalText(messages: readonly AgentMessage[]): string {
  const last = [...messages].reverse().find(m => m.role === 'assistant');
  return last ? textContent(last.content, false).trim() : '';
}

export class SlackBridge {
  private generation = 0;
  /** The inbox read in flight, cancelled by stop(). */
  private cancelRead: AbortController | undefined;
  private polling = false;
  private pollFailure: string | undefined;
  private itemsFailure: string | undefined;
  private offUntil = 0;
  /** Set when a `[Slack]` message entered the current run: its final answer goes back to the DM. */
  private answering: Origin | undefined;
  /** Set when a heartbeat wake started the current run: what it delivered is reported to the repo's channel. */
  private waking = false;
  private running = false;
  /** The latest finished assistant reply of a run answering Slack, and the reply already delivered early. */
  private replied = '';
  private delivered = '';
  private readonly threads = new Map<string, Origin>();
  /** Approval posts by their DM ts, until decided or expired. */
  private readonly approvals = new Map<string, Post>();
  /** Rewrites of decided approval posts, in order. */
  private settling: Promise<unknown> = Promise.resolve();
  private readonly options: { intervalMs: number; waitMs: number; heldMs: number; now: () => number; request: Request; warn: (text: string) => void; sent: (channel: string | null, text: string) => void;
    schedule: (run: () => void, ms: number) => void;
    /** Word budget of project channels by name (src/slack-policy.ts); the DM and unlisted channels use the default. */
    wordBudgets: WordBudgets;
    /** The work the App Home lists: open PRs, open commitments, running jobs (src/home-items.ts). */
    items: () => HomeWork;
    /** Whether the chat can take a DM now. While not, the inbox is left alone: a message handed to a chat that drops it would still move the cursor. */
    accepting: () => boolean;
    /** The selected model (`provider/id`) and pi-multi-account's state, for the commands answered without a turn and the App Home. */
    model: () => string | undefined; failover: () => unknown;
    models: () => readonly ModelRef[]; select: (model: ModelRef) => Promise<boolean>;
    /** Stops the run in progress (the Home's Parar, the DM's `parar`); false when idle. */
    abort: () => boolean;
    /** When the heartbeat next checks for a wake, if armed. */
    nextWake: () => number | undefined };
  /** First line of the App Home: what the agent is doing now. */
  private activity = '\u2705 *Livre*';
  /** The current run as the App Home shows it: since when, from where, what was asked, its latest step and how many. */
  private work: { since: number; origin: string; about: string; step: string; steps: number; shown: number } | undefined;
  private waiting: () => readonly (string | WaitingItem)[] = () => [];
  private homeText = '';
  /** The Home's Ver tudo: every PR, commitment and job instead of the first few; Ver menos folds them again. */
  private expanded = false;

  constructor(private readonly pi: Pick<ExtensionAPI, 'sendUserMessage'>, private readonly owner: () => SlackOwner | undefined,
    options: Partial<SlackBridge['options']> = {}) {
    this.options = { intervalMs: 3000, waitMs: LONG_POLL_MS, heldMs: HELD_MS, now: Date.now, request: defaultRequest, warn: () => {}, sent: () => {}, schedule: (run, ms) => { setTimeout(run, ms).unref?.(); }, wordBudgets: {}, items: () => NO_WORK, accepting: () => true, model: () => undefined, failover: failoverReader(QUOTA_FILE),
      models: () => [], select: async () => false, abort: () => false, nextWake: () => undefined, ...options };
  }

  /**
   * Reads the inbox as a long poll: the service holds each read until a message comes, so a message is handed over as it
   * arrives. A read the service held is followed at once; one it answered at once (or failed) waits the interval.
   */
  start(): void {
    this.stop();
    this.cycle(++this.generation);
  }
  private cycle(generation: number): void {
    if (generation !== this.generation) return;
    const started = this.options.now();
    const cancel = this.cancelRead = new AbortController();
    void this.poll(cancel.signal).then(delivered => { this.pollFailure = undefined; return delivered; }, error => { if (generation === this.generation && !cancel.signal.aborted) this.pollFailed(error); return 0; })
      .then(delivered => {
        if (generation !== this.generation) return;
        const again = delivered > 0 || this.options.now() - started >= this.options.heldMs ? 0 : this.options.intervalMs;
        this.options.schedule(() => this.cycle(generation), again);
      });
  }
  /** A pass that throws (the cursor cannot be written, the chat refuses the message) is retried at the next interval; it must not escape as an unhandled rejection, and a repeat of the same failure is said once. */
  private pollFailed(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error);
    if (text === this.pollFailure) return;
    this.pollFailure = text;
    this.options.warn(`Slack inbox pass failed; it retries: ${text}`);
  }
  stop(): void {
    this.generation++; this.cancelRead?.abort(); this.cancelRead = undefined;
    this.answering = undefined; this.waking = false; this.running = false;
  }
  runStarted(): void { this.running = true; this.work = undefined; }
  /** What waits for the operator (approvals, items blocked on him); shown on the App Home, working or free. */
  setWaiting(read: () => readonly (string | WaitingItem)[]): void { this.waiting = read; }

  /** Each tool call of the run: the App Home names the step, at most once per HOME_STEP_MS so Slack is not flooded. */
  toolStarted(tool: string, args: unknown): void {
    if (!this.work) return;
    this.work.steps++;
    this.work.step = stepLabel(tool, args);
    if (this.work.steps === 1 || this.options.now() - this.work.shown >= HOME_STEP_MS) this.showWork();
  }

  private showWork(): void {
    const w = this.work!;
    const now = this.options.now();
    w.shown = now;
    const minutes = Math.floor((now - w.since) / 60_000);
    this.home([`\u{1f504} *Trabalhando* há ${minutes} min (desde ${clock(w.since)}, ${w.origin})`, `> ${w.about}`,
      ...w.steps ? [`Agora: ${w.step} · ${w.steps} passo${w.steps === 1 ? '' : 's'}`] : []].join('\n'));
  }

  /** The work as items (PRs, commitments, jobs, subagents); a reader that fails leaves them out, and the Home still goes out. */
  private readWork(): HomeWork {
    try { return this.options.items(); }
    catch (error) {
      // Said once, like a failing inbox pass: the Home repeats at every run end.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.itemsFailure) { this.itemsFailure = message; this.options.warn(`App Home items not read: ${message}`); }
      return NO_WORK;
    }
  }

  private readWaiting(): WaitingItem[] {
    try { return this.waiting().slice(0, 5).map(i => typeof i === 'string' ? { text: i } : i); } catch { return []; /* the Home still goes out */ }
  }

  /** Each item, then what is asked of him on its own line; answers he can tap go as buttons under the Home's text. */
  private static waitingBlock(items: readonly WaitingItem[]): string {
    return items.length ? `\n\n*Esperando você*\n${items.map(i => `• ${clipWords(i.text, 160)}${i.ask ? `\n   \u21b3 _${clipWords(i.ask, 200)}_` : ''}`).join('\n')}` : '';
  }

  /** One pass: new DMs become user messages in order; the cursor advances only past delivered ones. */
  async poll(cancel?: AbortSignal): Promise<number> {
    const owner = this.owner();
    if (!owner || this.polling || !this.options.accepting() || this.options.now() < this.offUntil) return 0;
    this.polling = true;
    try {
      const seq = this.cursor(owner);
      const wait = this.options.waitMs > 0 ? `&wait=${this.options.waitMs}` : '';
      let value: unknown;
      try { value = await this.options.request(owner, `/v1/slack/inbox?after=${seq}&limit=20${wait}`, undefined, cancel); }
      catch (error) {
        // Cancelled by stop(): nothing failed, so nothing backs off.
        if (cancel?.aborted) return 0;
        // An assistant that predates the long poll refuses `wait`: plain reads from now on, with no back-off.
        if (wait && error instanceof HttpError && error.status === 400) { this.options.waitMs = 0; return 0; }
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
            // The Home's Ver tudo / Ver menos: the Home itself changes, no DM and no model.
        if (m.channel === HOME_FOLD.channel && (m.text === HOME_FOLD.more || m.text === HOME_FOLD.less)) {
          this.expanded = m.text === HOME_FOLD.more;
          this.refreshHome();
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
        const text = `${slackPrefix(channel)}${m.text}${extras}\n\n${budgetNote(wordBudget(channel, this.options.wordBudgets))}${this.running ? MID_RUN : ''}`;
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
    // Files and linked messages are independent reads: they go out together, each part says its own failure, and the order he wrote is kept.
    const [lines, quotes] = await Promise.all([
      mapBounded(Array.isArray(m.files) ? m.files : [], FILE_READS, file => this.attachment(owner, file)),
      Promise.all([...m.text.matchAll(SLACK_LINK)].slice(0, 3).map(([, channel, sec, frac, thread]) => this.quote(owner, channel!, `${sec}.${frac}`, thread))),
    ]);
    const files = lines.length ? `\n\nAnexos:\n${lines.join('\n')}` : '';
    return files + (quotes.length ? `\n\n${quotes.join('\n\n')}` : '');
  }

  /** One file he sent, saved locally: its line for the message, with what the agent should do with it. */
  private async attachment(owner: SlackOwner, file: SlackFile): Promise<string> {
    try {
      const { path } = await this.options.request(owner, '/v1/slack/download', { url: file.url, name: file.name }) as { path: string };
      const hint = file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/') ? ' (transcreva com transcribe_file)' : file.mimetype.startsWith('image/') ? ' (veja com read)' : '';
      return `- ${file.name} [${file.mimetype}]: ${path}${hint}`;
    } catch (error) { return `- ${file.name} [${file.mimetype}]: não baixou (${error instanceof Error ? error.message : String(error)})`; }
  }

  /** One Slack message he linked, quoted; a failure says why, so the agent never answers as if it had read it. */
  private async quote(owner: SlackOwner, channel: string, ts: string, thread: string | undefined): Promise<string> {
    try {
      const found = await this.options.request(owner, '/v1/slack/fetch', { channel, ts, thread: thread ?? ts }) as { user: string; text: string };
      return `Mensagem linkada (<@${found.user}> em <#${channel}>):\n${found.text.split('\n').map(line => `> ${line}`).join('\n')}`;
    } catch (error) { return `Mensagem linkada em <#${channel}>: não consegui ler (${error instanceof Error ? error.message : String(error)}; o bot precisa estar no canal).`; }
  }

  /** An emoji on the operator's message: 👀 when it reached the chat, ✅ when the answer went out. Never blocks. */
  private react(owner: SlackOwner, channel: string, ts: string, name: string, remove = false): void {
    void this.options.request(owner, '/v1/slack/react', { channel, ts, name, remove }).catch(() => undefined);
  }

  /** The operator's App Home in Slack shows what the assistant is doing right now. Never blocks. */
  /** Republishes the Home as it stands (a new or settled approval changes its buttons). */
  private refreshHome(): void { if (this.homeText) this.home(this.homeText); }

  private home(text: string): void {
    this.homeText = text;
    const owner = this.owner();
    const work = this.readWork(), background = backgroundSummary(work);
    // Idle in the chat is not idle: subagents or shells still running say so instead of "Livre".
    if (!this.work && background) text = text.replace(IDLE, `\u23f3 *Em segundo plano* (${background} rodando) \u00b7 chat livre`);
    this.activity = text.split('\n')[0]!;
    const waiting = this.readWaiting(), items = renderWorkParts(work, this.expanded);
    let status = SlackBridge.waitingBlock(waiting) + (items.text ? `\n\n${items.text}` : '');
    try { if (owner) { const today = renderDay(readDay(owner.dir, this.options.now()), this.options.now(), this.options.nextWake()); if (today) status += `\n\n${today}`; } } catch { /* the Home goes out without the day */ }
    try { status += `\n\n${homeStatus(this.commandState())}`; } catch { /* the activity line still goes out */ }
    // Buttons: Parar only while working; Aprovar decides the newest pending approval post, as a tap on that post would.
    const approval = [...this.approvals].filter(([, p]) => p.request.expires > this.options.now()).at(-1)?.[0];
    if (!owner) return;
    const full = `${clipWords(text, HOME_CHARS - status.length)}${status}`;
    const choices = waiting.filter(w => w.choices?.length).slice(0, 3).map(w => ({ label: clipWords(w.text, 120), options: w.choices! }));
    const fold = items.hidden ? 'more' : this.expanded ? 'less' : undefined;
    // A service from before these fields refuses them (HTTP 400): the old 3000-character text alone still goes out.
    const old = { text: `${clipWords(text, 2900 - status.length)}${status}`.slice(0, 3000) };
    void this.options.request(owner, '/v1/slack/home', { text: full, working: !!this.work, ...(approval ? { approval } : {}), ...(choices.length ? { choices } : {}), ...(fold ? { fold } : {}) })
      .catch(error => error instanceof Error && /HTTP 400/.test(error.message) ? this.options.request(owner, '/v1/slack/home', old) : undefined).catch(() => undefined);
  }

  /** What the remote commands read: the live model and activity, and pi-multi-account's cached quota. */
  commandState(): CommandState {
    const { model, failover, now, models, select, abort } = this.options;
    return { model, activity: () => this.activity, failover, now, models, select, abort };
  }

  /** Answers a remote command in the DM; an effect it asks to confirm goes out as an approval post first. */
  private async command({ command, arg }: NonNullable<ReturnType<typeof remoteCommand>>): Promise<void> {
    const result = await command.run(this.commandState(), arg);
    if (!result.confirm) { await this.send(result.text); this.answered(null); return; }
    const { summary, apply } = result.confirm;
    let ran = false;
    const posted = await this.askApproval({
      token: `cmd-${randomUUID()}`, label: `Comando *${command.name}*`, summary: `${result.text} ${summary}`.slice(0, 500), expires: this.options.now() + COMMAND_APPROVAL_MS,
      decide: () => !ran && (ran = true),
      onPhone: async approve => approve ? apply() : `Negado: continuo em ${this.options.model() ?? 'nenhum modelo'}.`,
    });
    // An approval nobody can see would leave the operator waiting on silence.
    if (!posted) await this.send(`Não consegui postar o Aprovar no Slack; nada mudou, continuo em ${this.options.model() ?? 'nenhum modelo'}. Tente de novo ou use /approve no terminal.`).catch(() => {});
    this.answered(null);
  }

  /** Called for every user message of a run; a `[Slack]` one makes this run answer where it came from. */
  sawUserMessage(text: string): void {
    const match = FROM_SLACK.exec(text);
    const wake = wakeTask(text) !== undefined;
    const about = wake ? 'turno automático (wake)' : text.replace(FROM_SLACK, '').replace(MID_RUN, '').split('\n')[0]!.slice(0, 300);
    // The first message of a run names it, wherever it came from; a later Slack message renames it, a gitwatch notice does not.
    if (!this.work || match) {
      this.work = { since: this.work?.since ?? this.options.now(), origin: wake ? 'wake' : match ? 'Slack' : 'terminal', about, step: '', steps: this.work?.steps ?? 0, shown: 0 };
      this.showWork();
    }
    if (wake) { this.waking = true; return; }
    if (!match) {
      // Another message (a gitwatch notice, a wake) steering this run would otherwise replace the answer the operator is waiting for.
      if (this.answering && this.replied && this.replied !== this.delivered) { this.delivered = this.replied; void this.answer(this.answering, this.replied, false); }
      return;
    }
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
  /** Every finished assistant message: a text-only one is the reply so far to the Slack message of this run. */
  assistantSaid(message: AgentMessage): void {
    if (message.role !== 'assistant' || !this.answering) return;
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content) && content.some(part => (part as { type?: string })?.type === 'toolCall')) return;
    const text = textContent(message.content, false).trim();
    if (text) this.replied = text;
  }

  private async answer(answering: Origin, text: string, closing: boolean): Promise<void> {
    const thread = answering.threaded ? answering.thread ?? answering.ts ?? null : answering.thread;
    try {
      await this.publish(text, thread, answering.channel, answering.threaded && !answering.thread ? { broadcast: true } : {});
      this.answered(answering.channel);
      const owner = this.owner();
      if (closing && owner && answering.id && answering.ts) { this.react(owner, answering.id, answering.ts, SEEN, true); this.react(owner, answering.id, answering.ts, DONE); }
    }
    catch (error) { this.options.warn(`Slack reply not sent: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async runEnded(messages: readonly AgentMessage[]): Promise<void> {
    const answering = this.answering, waking = this.waking, delivered = this.delivered;
    this.answering = undefined; this.waking = false; this.replied = ''; this.delivered = '';
    this.running = false;
    const steps = this.work?.steps ?? 0, work = this.work, owner = this.owner();
    this.work = undefined;
    if (work && steps && owner) try { recordRun(owner.dir, { start: work.since, end: this.options.now(), about: work.about, origin: work.origin, steps }); } catch { /* the Home's day is a courtesy */ }
    const last = finalText(messages);
    this.home(`\u2705 *Livre* desde ${clock(this.options.now())}${steps ? ` · último trabalho: ${steps} passo${steps === 1 ? '' : 's'}` : ''}${last ? `\n\u00daltima resposta:\n${clipWords(last, 1200)}` : ''}`);
    if (answering) {
      // After progress in the thread, the answer closes it and also shows in the conversation.
      if (last && last === delivered) return;
      await this.answer(answering, last || EMPTY_RUN, true);
      return;
    }
    const text = waking && finalText(messages);
    const channel = text ? wakeChannel(messages) : undefined;
    if (!text || channel === undefined) return;
    try { await this.publish(`*Wake* · ${text}`, null, channel); }
    catch (error) { this.options.warn(`Wake report not sent to Slack: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Posts a gated call to the operator's DM with Aprovar/Negar buttons; a tap (relayed by the service as that reply) or
   * their `aprovar`/`negar` in its thread decides it. Best effort: the terminal `/approve` keeps working when Slack is down.
   */
  async askApproval(request: ApprovalRequest): Promise<boolean> {
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
      this.refreshHome();
      this.options.schedule(() => void this.settled(request.token, 'expired'), Math.max(0, request.expires - now));
      return true;
    } catch (error) { this.options.warn(`Approval not posted to Slack: ${error instanceof Error ? error.message : String(error)}`); return false; }
  }

  /** The call of an approval post stopped waiting outside Slack (terminal, a newer call, expiry): the post says so. */
  settled(token: string, outcome: Settled): Promise<unknown> {
    const found = [...this.approvals].find(([, post]) => post.request.token === token);
    if (!found) return this.settling;
    this.approvals.delete(found[0]);
    this.refreshHome();
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
    this.refreshHome();
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
    if (!topic || !owner) return this.publish(text, this.progressThread(channel), channel);
    const file = join(owner.dir, TOPICS), now = this.options.now();
    let topics: Record<string, { channel: string | null; ts: string; at: number }> = {};
    try { topics = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
    const known = topics[topic];
    const open = known && known.channel === channel && now - known.at < TOPIC_DAYS * 86_400_000 ? known : undefined;
    const result = await this.publish(text, open?.ts ?? null, channel);
    if (!open) {
      topics[topic] = { channel, ts: result.ts, at: now };
      const fresh = Object.entries(topics).filter(([, t]) => now - t.at < TOPIC_DAYS * 86_400_000).slice(-300);
      atomicWrite(file, JSON.stringify(Object.fromEntries(fresh)));
    }
    return result;
  }

  /**
   * A post the agent wants to make (a final answer, a wake report, slack_send): within its channel's word budget it is one
   * post; over it, the short head goes first and the full text follows as a reply in the same thread (or under the head).
   */
  private async publish(text: string, threadTs: string | null, channel: string | null, options: { broadcast?: true } = {}): Promise<{ parts: number; ts: string; channel?: string }> {
    const { head, full } = fitPost(text, wordBudget(channel, this.options.wordBudgets));
    const sent = await this.send(head, threadTs, channel, options);
    if (full !== undefined) await this.send(full, threadTs ?? sent.ts, channel);
    return sent;
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
  options: { request?: Request; accepting?: () => boolean; nextWake?: () => number | undefined; items?: () => HomeWork; wordBudgets?: WordBudgets } = {}): SlackBridge {
  let abort: () => boolean = () => false;
  let warn: (text: string) => void = () => {};
  let model: string | undefined;
  const named = (m: { provider: string; id: string } | undefined) => m ? `${m.provider}/${m.id}` : undefined;
  let registry: { getAvailable(): readonly ModelRef[]; find(provider: string, id: string): unknown } | undefined;
  const bridge = new SlackBridge(pi, owner, {
    warn: text => warn(text), sent, model: () => model, abort: () => abort(),
    models: () => registry?.getAvailable().map(m => ({ provider: m.provider, id: m.id })) ?? [],
    // Through Pi, like `/model`: pi-multi-account sees an ordinary user switch.
    select: async ({ provider, id }) => { const found = registry?.find(provider, id); return found ? pi.setModel(found as never) : false; },
    ...options,
  });
  pi.on('session_start', (_event, ctx) => { abort = () => { if (ctx.isIdle()) return false; ctx.abort(); return true; }; warn = text => ctx.ui.notify(text, 'warning'); model = named(ctx.model); registry = ctx.modelRegistry; bridge.start(); });
  // pi-multi-account switches by selecting the other account's model, so this follows its failovers too.
  pi.on('model_select', event => { model = named(event.model); });
  pi.on('session_shutdown', () => bridge.stop());
  pi.on('message_end', ({ message }) => { const text = promptText(message); if (text !== undefined) bridge.sawUserMessage(text); else bridge.assistantSaid(message); });
  pi.on('agent_start', () => bridge.runStarted());
  pi.on('tool_execution_start', event => bridge.toolStarted(event.toolName, event.args));
  pi.on('agent_end', event => bridge.runEnded(event.messages));
  pi.registerTool({
    name: 'slack_send', label: 'Message the operator on Slack',
    description: "Send a message to the operator on Slack; they read it on the phone. Use it to report finished work, progress on long tasks and blockers that need their decision, especially when they may be away; never post shell or subagent completions (commands, exit codes, test output), only what the work delivered. `channel` posts to a project channel instead of the DM: dentai (dentai-mono), genexus18mcp (Genexus18MCP), harness (pi-optchat, pi-subagents, pi-goal-x, pi-multi-account, pi-ripwire, dotfiles); route reports by the repo the work is in, and keep the DM for general matters, urgent blockers and decisions. A [Slack] or [Slack #channel] message that arrives while you are working: answer it here (same channel) and keep working, since a text-only reply ends the run. When the run started from a Slack message, its final answer goes back automatically: don't repeat it here. Keep each message within the channel's word budget (100 words by default): a longer one posts a short head, and its full text follows in the thread.",
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
