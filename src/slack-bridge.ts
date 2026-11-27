import { slackMemoryKey, type UndoCommand } from './memory-undo.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { CLAIM_CHECK_PREFIX } from './claim-check.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { assistantConfig, assistantRequest, HttpError } from './assistant-client.ts';
import type { Settled } from './authorization.ts';
import { promptText, wakeTask } from './heartbeat.ts';
import { recordAnswer, recordInbound } from './slack-metrics.ts';
import { delivers, projectOf, projectOfRepo, toolCalls } from './projects.ts';
import { awayRecap } from './away-recap.ts';
import { readDay, recordRun, renderDay } from './home-day.ts';
import type { Economy } from './quota-economy.ts';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { failoverReader, homeStatus, modelName, remoteCommand, type CommandState, type ModelRef } from './remote-commands.ts';
import { randomUUID } from 'node:crypto';
import { QUOTA_FILE } from './quota-health.ts';
import { atomicWrite } from './store.ts';
import { scrubSecrets } from './secret-scrub.ts';
import { textContent } from './transcript.ts';
import { transcribeAudio } from './transcribe.ts';
import { budgetNote, MID_RUN, wordBudget, type WordBudgets } from './slack-policy.ts';
import { phaseOf } from './waiting-board.ts';
import { idleLine, NO_WORK, renderWorkParts, type HomeWork } from './home-items.ts';
import { homeDashboard, homeGraph, homeProduction } from './home-dashboard.ts';
import { memoryShapedReply } from './wake-noise.ts';
import { WAKE_LOG_CHANNEL, councilThread, wakeLogPost } from './wake-log.ts';
import type { WaitingItem } from './commitments.ts';
import { activeRefusals, recordRefusal, rememberWake, revokeRefusal } from './wake-refusal.ts';
import { canCard, extractPlan, planShape } from '../assistant/src/channels/plan-card.ts';
import {
  RemoteLoginManager,
  accountLabel,
  authFailureFromMessages,
  type AuthStorageLike,
  type LoginCompletionEvent,
  type ResumePrompt,
} from './remote-login.ts';

/**
 * The operator's Slack DM as a second door into this chat. The assistant service queues the operator's DMs; this
 * bridge polls them over the loopback API, hands each to the agent as a user message marked `[Slack]`, and posts the
 * run's final answer back to the DM. `slack_send` lets the agent write first (progress, finished work, a blocker).
 * Every heartbeat wake posts its effects and final answer to the #wakes log; without that channel, a wake that delivered
 * something (an edit, commit, push or PR) posts its final answer to that repo's channel.
 * Pi marks these messages as extension input, so a Slack message never approves a gated effect by itself. The one
 * exception is an approval post (`askApproval`): the operator's `aprovar` or `negar` in that post's DM thread decides
 * that one pending call. The service queues only human messages from the configured operator, and Slack signs them, so
 * the agent cannot write such a reply.
 */
export const SLACK_PREFIX = '[Slack] ';

const slackPrefix = (channel: string | null) => channel ? `[Slack #${channel}] ` : SLACK_PREFIX;
export const FROM_SLACK = /^\[Slack(?: #([a-z0-9][a-z0-9_-]{0,79}))?\] /;
const FROM_WHATSAPP = /^\[WhatsApp\] /;
export type SlackOwner = { dir: string; name: string };
type SlackFile = { id: string; name: string; mimetype: string; url: string };
type Inbound = { seq: number; ts: string; thread: string | null; text: string; channel?: string; channelName?: string | null; files?: SlackFile[]; operatorText?: { text: string; ts: string }; undoTs?: string };

type Origin = { thread: string | null; channel: string | null; id?: string; ts?: string; threaded?: boolean; startText?: string; opening?: Promise<string | null>; promptText?: string };
const REAL_CHANNEL = /^[CDG][A-Z0-9]{2,20}$/;

const FILE_READS = 4;

const SLACK_LINK = /https:\/\/[\w-]+\.slack\.com\/archives\/([CDG][A-Z0-9]{2,20})\/p(\d{10})(\d{6})(?:\?[^\s>|]*thread_ts=(\d{10}\.\d{6}))?/g;
const SEEN = 'eyes', DONE = 'white_check_mark';
type Request = (owner: SlackOwner, path: string, body?: unknown, cancel?: AbortSignal) => Promise<unknown>;
const CURSOR = 'slack-cursor.json';
const OFF_FOR_MS = 5 * 60_000;

const LONG_POLL_MS = 15_000;

const HELD_MS = 1_000;
const TASK_THREAD_AFTER_MS = 60_000;

const COMMAND_APPROVAL_MS = 10 * 60_000;
// external: pi-multi-account injects resume prompts after quota, rate-limit or transient provider errors.
const PROVIDER_RESUME = /^Provider (?:failover|retry|quota recovery) activated:/, RESUME_WINDOW_MS = 30 * 60_000;
const EMPTY_RUN = 'Recebi, mas a execução terminou sem resposta em texto (erro ou interrupção). Manda de novo se precisar.';


export const slackRequestTimeout = (path: string) => path === '/v1/slack/home' ? 120_000 : 20_000;
const defaultRequest: Request = async (owner, path, body, cancel) => assistantRequest(assistantConfig(owner), path, body, slackRequestTimeout(path), cancel);
const APPROVE = /^(?:aprovar|aprova|aprovado|sim|ok|approve)[.!]?$/i;
const DENY = /^(?:negar|nega|negado|n[aã]o|deny)[.!]?$/i;
const APPROVE_SESSION = /^aprovar sess[aã]o$/i;
/** A gated call waiting for the operator, and how to decide it. */
export type ApprovalRequest = { token: string; summary: string; label: string; expires: number;
  /** The whole invocation, shown verbatim in the post so the operator sees exactly what he approves. */
  detail?: string; decide: (approve: boolean) => boolean;
  /** Why the call needs the operator, and the files or repository it touches, shown above the command. */
  reason?: string; targets?: readonly string[];
  /** The exact scope a session allow would cover (shown on its button); only set together with `allowSession`, which approves the call and allows that scope. */
  sessionAllow?: string; allowSession?: () => boolean;
  /** An effect the bridge itself runs on the phone's decision (a remote command); its answer replaces the note to the agent. */
  onPhone?: (approve: boolean) => Promise<string> };

const SETTLED_TEXT: Record<Settled | 'phone-approved' | 'phone-denied' | 'phone-session', string> = {
  'phone-session': '\u2705 *Aprovado no Slack e liberado nesta sess\u00e3o*',
  approved: '\u2705 *Aprovado no terminal*', denied: '\u{1f6ab} *Negado no terminal*', superseded: '\u21aa\ufe0f *Substitu\u00edda por uma chamada mais nova*',
  expired: '\u231b *Expirou sem decis\u00e3o*', 'phone-approved': '\u2705 *Aprovado no Slack*', 'phone-denied': '\u{1f6ab} *Negado no Slack*',
};
type Post = { request: ApprovalRequest; channel: string | null };
const TOPICS = 'slack-threads.json';
const TOPIC_DAYS = 14;

const clock = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

const HOME_STEP_MS = 20_000;

const HOME_CHARS = 11_000;
const IDLE = /^\u2705 \*Livre\*/;

const HOME_FOLD = { channel: 'home', more: 'tudo', less: 'menos' } as const;

const HOME_SETTING_VALUE = /^[\w./:-]{1,80}$/;

const refused = (error: unknown) => error instanceof HttpError ? error.status === 400 : error instanceof Error && /HTTP 400/.test(error.message);

/**
 * The Home's "Última resposta": the reply's opening paragraph, where the outcome goes, clipped; the whole answer is in
 * the DM. 03/11: the Home showed almost the whole reply and hid what mattered below it.
 */
export function replyLead(text: string, max = 280): string {
  const first = text.trim().split(/\n\s*\n/)[0]!.replace(/\s*\n\s*/g, ' ');
  return clipWords(first, max);
}

/** At most `max` characters, cut at a word and marked with \u2026, so a quote or a link is never cut in half silently. */
export function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '';
  const cut = text.slice(0, max - 1), space = cut.search(/\s\S*$/);
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}
function withoutCompactionBlocks(text: string): string {
  const clean = text.replace(/<compaction-line>[\s\S]*?(?:<\/compaction-line>|$)/g, '').trim();
  return memoryShapedReply(clean) ? '' : clean;
}

/** One short line for a thinking block: its first `**bold**` heading, else its first sentence, at most 90 characters. */
export function thoughtHeadline(thinking: string): string {
  const text = scrubSecrets(thinking).replace(/\s+/g, ' ').trim();
  const heading = /\*\*(.+?)\*\*/.exec(text)?.[1]?.trim();
  return clipWords(heading || /^.+?(?:[.!?](?=\s|$)|$)/.exec(text)?.[0] || '', 90);
}

function latestHeadline(previous: string, content: unknown): string {
  if (!Array.isArray(content)) return previous;
  let headline = previous;
  for (const part of content) {
    if (part?.type !== 'thinking' || part.redacted || typeof part.thinking !== 'string') continue;
    headline = thoughtHeadline(part.thinking) || headline;
  }
  return headline;
}

interface StepCounts { explored: number; edited: Set<string>; tests: number; git: number }
const noCounts = (): StepCounts => ({ explored: 0, edited: new Set(), tests: 0, git: 0 });

function countStep(counts: StepCounts, tool: string, args: unknown): void {
  const phase = phaseOf(tool, args);
  if (phase === 'lendo código') counts.explored++;
  else if (phase === 'editando') counts.edited.add(base((args as { path?: unknown } | undefined)?.path) || String(counts.edited.size));
  else if (phase === 'testes') counts.tests++;
  else if (phase === 'git') counts.git++;
}

/** The counts as one line of emoji dots (Slack has no text colour); empty while nothing was counted. */
export function countsLine(counts: StepCounts): string {
  return [
    counts.explored && `\u{1f50d} Explorou ${counts.explored}`,
    counts.edited.size && `\u270f\ufe0f editou ${counts.edited.size} arquivo${counts.edited.size === 1 ? '' : 's'}`,
    counts.tests && `\u{1f9ea} ${counts.tests} teste${counts.tests === 1 ? '' : 's'}`,
    counts.git && `\u{1f33f} git ${counts.git}`,
  ].filter(Boolean).join(' \u00b7 ');
}
const base = (path: unknown) => typeof path === 'string' ? path.split(/[\\/]/).pop() ?? path : '';


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

/**
 * Where a wake's result belongs: the channel of the repository its delivering calls touched most, or the DM when they
 * touched none of the mapped repositories. `undefined` when the wake delivered nothing (or already reported itself with
 * slack_send): an empty wake posts nothing.
 */
export function wakeChannel(messages: readonly AgentMessage[]): string | null | undefined {
  const calls = toolCalls(messages);
  if (calls.some(c => c.name === 'slack_send')) return undefined;
  const delivering = calls.filter(delivers);
  if (!delivering.length) return undefined;
  return projectOf(...delivering.map(call => JSON.stringify(call.arguments))) ?? null;
}

export function finalText(messages: readonly AgentMessage[]): string {
  const last = [...messages].reverse().find(m => m.role === 'assistant');
  return last ? withoutCompactionBlocks(textContent(last.content, false)) : '';
}


function failure(messages: readonly AgentMessage[]): string {
  const last = [...messages].reverse().find(m => m.role === 'assistant') as { stopReason?: string; errorMessage?: string } | undefined;
  return last && (last.stopReason === 'error' || last.stopReason === 'aborted') ? `⚠️ A execução parou sem resposta (${last.stopReason}): ${last.errorMessage ?? 'sem detalhes'}` : '';
}

const WORKER_PROGRESS = /^\[[\w-]+\] Message from subagent \(still running\)/;
const SHELL_END = /^\[shell [\w-]+\]/;
const SHELL_FOLLOW_UP_MS = 12 * 3_600_000;

export class SlackBridge {
  private generation = 0;
  /** The inbox read in flight, cancelled by stop(). */
  private cancelRead: AbortController | undefined;
  private polling = false;
  private pollFailure: string | undefined;
  private itemsFailure: string | undefined;
  /** The last Home failure said, so a service that keeps refusing is reported once, not at every run end. */
  private homeFailure: string | undefined;
  private homeInflight = false;
  /** A `[WhatsApp]` message entered the current run: its answer goes back there, not to Slack. */
  private whatsapp = false;
  /** Every message of this run so far was a still-running worker's progress note: its answer is chatter, not news for the DM. */
  private progressOnly: boolean | undefined;
  private homeNext: { owner: NonNullable<ReturnType<SlackBridge['owner']>>; body: object; old: object } | undefined;
  private offUntil = 0;
  /** Set when a `[Slack]` message entered the current run: its final answer goes back to the DM. */
  private answering: Origin | undefined;
  private taskThreadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set when a heartbeat wake started the current run: what it delivered is reported to the repo's channel. */
  private waking = false;
  private running = false;
  /** Arguments of this run's tool calls, so a slack_send without a channel goes to the project the work is in. */
  private touched: string[] = [];
  /** The latest finished assistant reply of a run answering Slack, and the reply already delivered early. */
  private replied = '';
  private delivered = '';
  private readonly threads = new Map<string, Origin>();
  private readonly loggedOrigins = new WeakMap<AgentMessage, string>();
  memoryKey(message: AgentMessage) { return this.loggedOrigins.get(message); }
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
    /** The quota economy (US$ per 1%) the `cota` command adds to each account, when there is one. */
    economy?: () => Economy | undefined;
    memoryUndo?: (command: UndoCommand) => string;
    /** The thinking level as `/thinking` sees it, and setting it: the `thinking` command and the Home's menu. */
    thinking?: CommandState['thinking']; setThinking?: CommandState['setThinking']; proactivityPaused?: CommandState['proactivityPaused'];
    /** On (setting `slackEveryAnswer`, for a Pi nobody watches at a terminal): the final answer of every run, not only of Slack and wakes, goes to the DM. */
    everyAnswer?: () => boolean;
    taskThreadAfterMs?: () => number | undefined;
    /** Stops the run in progress (the Home's Parar, the DM's `parar`); false when idle. */
    abort: () => boolean;
    /** When the heartbeat next checks for a wake, if armed. */
    nextWake: () => number | undefined;
    /** Notifies listeners when an inbound operator message is recorded, so timers can adjust without polling. */
    onInbound?: (channel: string | null, at: number) => void;
    /** A voice note he sent, as text (src/transcribe.ts). */
    transcribe: (path: string) => Promise<string>;
    /** Remote OAuth login coordinator for headless re-authentication via Slack DM. */
    remoteLogin?: RemoteLoginManager };
  /** First line of the App Home: what the agent is doing now. */
  private activity = '\u2705 *Livre*';
  /** The current run as the App Home shows it: since when, from where, what was asked, its latest step and how many. */
  private work: { since: number; origin: string; about: string; step: string; stepSince: number; steps: number; shown: number; headline: string; counts: StepCounts } | undefined;
  private workTimer: ReturnType<typeof setTimeout> | undefined;
  /** The wake whose run a provider error cut short: pi-multi-account resumes it with a user message that is no wake prompt. */
  private cutWake: { since: number; endedAt: number } | undefined;
  private wakeTopic = '';
  /** The Slack conversation the last answered run came from: the end of a shell that run left running is news for it. */
  private lastSlack: { origin: Origin; at: number } | undefined;
  private shellEnd = false;
  private waiting: () => readonly (string | WaitingItem)[] = () => [];
  private homeText = '';
  private readonly loginNotices = new Map<string, { at: number; notifiedAt: number }>();
  /** The Home's Ver tudo: every PR, commitment and job instead of the first few; Ver menos folds them again. */
  private expanded = false;

  constructor(private readonly pi: Pick<ExtensionAPI, 'sendUserMessage'>, private readonly owner: () => SlackOwner | undefined,
    options: Partial<SlackBridge['options']> = {}) {
    this.options = { intervalMs: 3000, waitMs: LONG_POLL_MS, heldMs: HELD_MS, now: Date.now, request: defaultRequest, warn: () => {}, sent: () => {}, schedule: (run, ms) => { setTimeout(run, ms).unref?.(); }, wordBudgets: {}, items: () => NO_WORK, accepting: () => true, model: () => undefined, failover: failoverReader(QUOTA_FILE),
      models: () => [], select: async () => false, abort: () => false, nextWake: () => undefined, transcribe: transcribeAudio, ...options };
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
    this.cancelTaskThread();
    clearTimeout(this.workTimer); this.workTimer = undefined; this.work = undefined;
  }
  runStarted(continuing = false): void { if (!continuing || !this.running) { clearTimeout(this.workTimer); this.workTimer = undefined; if (this.running) this.work = undefined; this.touched = []; } this.running = true; }
  /** What waits for the operator (approvals, items blocked on him); shown on the App Home, working or free. */
  setWaiting(read: () => readonly (string | WaitingItem)[]): void { this.waiting = read; }

  /** Each tool call of the run: the App Home names the step, at most once per HOME_STEP_MS so Slack is not flooded. */
  toolStarted(tool: string, args: unknown): void {
    if (this.touched.length < 400) { try { this.touched.push(JSON.stringify(args ?? null).slice(0, 2000)); } catch {   } }
    if (!this.work) return;
    this.work.steps++;
    countStep(this.work.counts, tool, args);
    this.work.step = stepLabel(tool, args);
    this.work.stepSince = this.options.now();
    if (this.work.steps === 1 || this.options.now() - this.work.shown >= HOME_STEP_MS) this.showWork();
    if (!this.workTimer) this.scheduleWork();
  }

  private scheduleWork(): void {
    this.workTimer = setTimeout(() => {
      this.workTimer = undefined;
      if (!this.running || !this.work?.steps) return;
      if (this.options.now() - this.work.shown >= HOME_STEP_MS) this.showWork();
      this.scheduleWork();
    }, Math.max(1, HOME_STEP_MS - (this.options.now() - (this.work?.shown ?? this.options.now()))));
    this.workTimer.unref?.();
  }

  private showWork(): void {
    const w = this.work!;
    const now = this.options.now();
    w.shown = now;
    const minutes = Math.floor((now - w.since) / 60_000);
    const seconds = Math.max(0, Math.floor((now - w.stepSince) / 1000));
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}min ${seconds % 60}s`;
    this.home([`\u{1f504} *Trabalhando* há ${minutes} min (desde ${clock(w.since)}, ${w.origin})`, `> ${w.about}`,
      ...w.headline ? [`*Pensando:* ${w.headline}`] : [],
      ...countsLine(w.counts) ? [countsLine(w.counts)] : [],
      ...w.steps ? [`Agora: ${w.step} · rodando há ${elapsed} · ${w.steps} passo${w.steps === 1 ? '' : 's'}`] : []].join('\n'));
  }

  /** The work as items (PRs, commitments, jobs, subagents); a reader that fails leaves them out, and the Home still goes out. */
  private readWork(): HomeWork {
    try { return this.options.items(); }
    catch (error) {

      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.itemsFailure) { this.itemsFailure = message; this.options.warn(`App Home items not read: ${message}`); }
      return { ...NO_WORK, prsKnown: false };
    }
  }

  private readWaiting(): WaitingItem[] {
    try { return this.waiting().slice(0, 5).map(i => typeof i === 'string' ? { text: i } : i); } catch { return [];   }
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

        if (cancel?.aborted) return 0;

        if (wait && error instanceof HttpError && error.status === 400) { this.options.waitMs = 0; return 0; }

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
        if (!channel && typeof m.thread === 'string' && this.approvals.has(m.thread) && (APPROVE.test(m.text.trim()) || DENY.test(m.text.trim()) || APPROVE_SESSION.test(m.text.trim()))) {
          await this.decided(m.thread, APPROVE.test(m.text.trim()) || APPROVE_SESSION.test(m.text.trim()), APPROVE_SESSION.test(m.text.trim()));
          atomicWrite(join(owner.dir, CURSOR), JSON.stringify({ seq: m.seq }));
          continue;
        }

        if (m.channel === HOME_FOLD.channel && (m.text === HOME_FOLD.more || m.text === HOME_FOLD.less)) {
          this.expanded = m.text === HOME_FOLD.more;
          this.refreshHome();
          atomicWrite(join(owner.dir, CURSOR), JSON.stringify({ seq: m.seq }));
          continue;
        }
        const history = !channel ? /^(undo|redo)(?:\s+([\s\S]*))?$/i.exec(m.text.trim()) : null;
        if (this.options.memoryUndo && (history || m.undoTs !== undefined)) {
          if (cancel?.aborted || this.owner()?.dir !== owner.dir) return delivered;
          if (this.running || delivered) return delivered;
          const reaction = typeof m.undoTs === 'string' && /^\d{1,12}\.\d{1,8}$/.test(m.undoTs)
            && typeof m.channel === 'string' && REAL_CHANNEL.test(m.channel);
          const request: UndoCommand | undefined = reaction ? { action: 'undo', arg: '', slack: slackMemoryKey(m.channel!, m.undoTs!), seq: m.seq }
            : history ? { action: history[1].toLowerCase() === 'undo' ? 'undo' : 'redo', arg: history[2] ?? '', seq: m.seq } : undefined;
          const reply = request && this.options.memoryUndo(request);
          atomicWrite(join(owner.dir, CURSOR), JSON.stringify({ seq: m.seq }));
          const thread = reaction && m.channel?.startsWith('D') ? m.undoTs! : null;
          if (reply) await this.publish(reply, thread, null).catch(error => {
            this.options.warn(`Slack memory command confirmation could not be posted: ${error instanceof Error ? error.message : String(error)}`);
          });
          continue;
        }
        const command = channel ? undefined : remoteCommand(m.text);
        if (!channel && this.options.remoteLogin && !command) {
          const loginStep = await this.options.remoteLogin.tryConsumeInput(m.text);
          if (loginStep) {
            atomicWrite(join(owner.dir, CURSOR), JSON.stringify({ seq: m.seq }));
            await this.send(loginStep.text, null, null, loginStep.choices ? { choices: loginStep.choices } : {}).catch(error => {
              this.options.warn(`Slack login reply not sent: ${error instanceof Error ? error.message : String(error)}`);
            });
            this.answered(null);
            this.refreshHome();
            if (loginStep.resumePrompt) this.resumeAfterLogin(loginStep.resumePrompt);
            continue;
          }
        }
        if (command) {

          try { await this.command(command); }
          catch (error) { this.options.warn(`Slack command "${command.command.name}" not answered: ${error instanceof Error ? error.message : String(error)}`); }
          atomicWrite(join(owner.dir, CURSOR), JSON.stringify({ seq: m.seq }));
          continue;
        }
        const id = typeof m.channel === 'string' && REAL_CHANNEL.test(m.channel) ? m.channel : undefined;
        if (id && typeof m.thread === 'string' && typeof m.operatorText?.text === 'string' && m.operatorText.ts === m.ts) {
          try { recordRefusal(owner.dir, id, m.thread, m.operatorText, this.options.now()); }
          catch (error) { this.options.warn(`Wake refusal not recorded: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (id) this.react(owner, id, m.ts, SEEN);
        const extras = await this.enrich(owner, m, id);
        const text = `${slackPrefix(channel)}${m.text}${extras}\n\n${budgetNote(wordBudget(channel, this.options.wordBudgets))}${this.running ? MID_RUN : ''}`;
        this.threads.set(text, { ...this.inboundOrigin(m, channel, id), promptText: text });
        this.pi.sendUserMessage(text, { deliverAs: 'steer' });
        atomicWrite(join(owner.dir, CURSOR), JSON.stringify({ seq: m.seq }));
        const inboundAt = this.options.now();
        this.measure(dir => recordInbound(dir, channel, m.text, inboundAt));
        this.options.onInbound?.(channel, inboundAt);
        delivered++;
      }
      return delivered;
    } finally { this.polling = false; }
  }

  private inboundOrigin(m: Inbound, channel: string | null, id?: string): Origin {
    const thread = typeof m.thread === 'string' ? m.thread : null;
    const startsTask = !this.running && !channel && !thread && id?.startsWith('D') && /^\d{1,12}\.\d{1,8}$/.test(m.ts);
    return { thread, channel, ...(id ? { id, ts: m.ts } : {}), ...(startsTask ? { startText: m.text } : {}) };
  }

  /**
   * What a message carries besides its text: the files the operator sent (saved locally, so the agent can look at an
   * image or transcribe an audio) and the Slack messages he linked (read by the bot). Each part is best effort and says
   * why when it fails, so the agent never answers as if it had seen something it did not.
   */
  private async enrich(owner: SlackOwner, m: Inbound, channelId?: string): Promise<string> {

    const [lines, quotes, parent] = await Promise.all([
      mapBounded(Array.isArray(m.files) ? m.files : [], FILE_READS, file => this.attachment(owner, file)),
      Promise.all([...m.text.matchAll(SLACK_LINK)].slice(0, 3).map(([, channel, sec, frac, thread]) => this.quote(owner, channel!, `${sec}.${frac}`, thread))),
      channelId && typeof m.thread === 'string' && m.thread !== m.ts ? this.threadParent(owner, channelId, m.thread) : Promise.resolve(''),
    ]);
    const files = lines.length ? `\n\nAnexos:\n${lines.join('\n')}` : '';
    return files + (quotes.length ? `\n\n${quotes.join('\n\n')}` : '') + parent;
  }

  /** A reply in a thread is about that thread: the message that opened it is quoted, so the answer keeps that subject. */
  private async threadParent(owner: SlackOwner, channel: string, thread: string): Promise<string> {
    try {
      const found = await this.options.request(owner, '/v1/slack/fetch', { channel, ts: thread, thread }) as { user?: unknown; text?: unknown };
      const raw = typeof found.text === 'string' && found.text.trim() ? found.text : '(sem texto: só anexo ou bloco)';
      const text = raw.length > 1500 ? `${raw.slice(0, 1500)}…` : raw;
      return `\n\nEm resposta à thread que começa com (<@${typeof found.user === 'string' ? found.user : '?'}>); o assunto dele é este:\n${text.split('\n').map(line => `> ${line}`).join('\n')}`;
    } catch (error) { return `\n\nEm resposta a uma thread; não consegui ler a mensagem que a abriu (${error instanceof Error ? error.message : String(error)}).`; }
  }

  /** One file he sent, saved locally: its line for the message, with what the agent should do with it. */
  private async attachment(owner: SlackOwner, file: SlackFile): Promise<string> {
    try {
      const { path } = await this.options.request(owner, '/v1/slack/download', { url: file.url, name: file.name }) as { path: string };
      const line = `- ${file.name} [${file.mimetype}]: ${path}`;
      if (file.mimetype.startsWith('audio/')) {

        try {
          const words = (await this.options.transcribe(path)).trim();
          return words ? `${line}\n  Transcrição: "${words}"` : `${line} (transcrição local vazia)`;
        } catch (error) { return `${line} (transcrição local falhou: ${error instanceof Error ? error.message : String(error)})`; }
      }
      return `${line}${file.mimetype.startsWith('video/') ? ' (vídeo: transcreva o áudio dele)' : file.mimetype.startsWith('image/') ? ' (veja com read)' : ''}`;
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
    const work = this.readWork(), idle = idleLine(work);

    if (!this.work && idle) text = text.replace(IDLE, idle);
    this.activity = text.split('\n')[0]!;
    const waiting = this.readWaiting(), items = renderWorkParts(work, this.expanded);
    let status = SlackBridge.waitingBlock(waiting) + (items.text ? `\n\n${items.text}` : '');
    try { if (owner) { const today = renderDay(readDay(owner.dir, this.options.now()), this.options.now(), this.options.nextWake()); if (today) status += `\n\n${today}`; } } catch {   }
    const settings = this.settings();
    try { status += `\n\n${homeStatus(this.commandState(), !!settings)}`; } catch {   }

    const approval = [...this.approvals].filter(([, p]) => p.request.expires > this.options.now()).at(-1)?.[0];
    if (!owner) return;
    const full = `${clipWords(text, HOME_CHARS - status.length)}${status}`;
    const choices = waiting.filter(w => w.choices?.length).slice(0, 3).map(w => ({ label: clipWords(w.text, 120), options: w.choices! }));
    const { team, ci } = homeDashboard(work, waiting.map(item => item.text), this.work ? 'working' : 'idle', this.options.model(), this.options.now());
    const production = homeProduction(owner.dir, this.options.now());
    const fold = items.hidden ? 'more' : this.expanded ? 'less' : undefined;


    const old = { text: `${clipWords(text, 2900 - status.length)}${status}`.slice(0, 3000) };
    this.publishHome(owner, { text: full, working: !!this.work, team, ci, production, graph: homeGraph(work, this.work ? 'trabalhando' : 'livre'), ...(approval ? { approval } : {}), ...(choices.length ? { choices } : {}), ...(fold ? { fold } : {}), ...(settings ? { settings } : {}) }, old);
  }

  /** The Home's menus: model (the account is its provider) and thinking level; each pick comes back as the `modelo`/`thinking` command. */
  private settings(): { model?: string; models: { value: string; label: string }[]; level?: string; levels?: readonly string[] } | undefined {
    const refs = this.options.models().map(m => `${m.provider}/${m.id}`).filter(ref => HOME_SETTING_VALUE.test(ref)).slice(0, 100);
    if (!refs.length) return undefined;
    const model = this.options.model(), thinking = this.options.thinking?.();
    return { ...(model && refs.includes(model) ? { model } : {}), models: refs.map(value => ({ value, label: modelName(value).slice(0, 75) })), ...(thinking ? { level: thinking.level, levels: thinking.levels } : {}) };
  }

  /** One Home publication at a time: requests that overlap can finish out of order and leave an older view on screen.
   *  A view requested while one is in flight replaces any earlier waiting one, so the newest always goes out last. */
  private publishHome(owner: NonNullable<ReturnType<SlackBridge['owner']>>, body: object, old: object): void {
    if (this.homeInflight) { this.homeNext = { owner, body, old }; return; }
    this.homeInflight = true;
    void this.sendHome(owner, body, old).finally(() => {
      this.homeInflight = false;
      const next = this.homeNext;
      this.homeNext = undefined;
      if (next) this.publishHome(next.owner, next.body, next.old);
    });
  }

  private sendHome(owner: NonNullable<ReturnType<SlackBridge['owner']>>, body: object, old: object): Promise<void> {
    return this.options.request(owner, '/v1/slack/home', body)
      .then(() => { this.homeFailure = undefined; }, async error => {
        if (!refused(error)) throw error;
        await this.options.request(owner, '/v1/slack/home', old);
        this.homeWarn('App Home: the assistant service refused the buttons (older than this extension); sent the text alone. Restart the service to load its new code.');
      })

      .catch(error => error instanceof Error && error.message.startsWith('Assistant disabled.') ? undefined
        : this.homeWarn(`App Home not published: ${error instanceof Error ? error.message : String(error)}`));
  }

  private homeWarn(message: string): void {
    if (message !== this.homeFailure) { this.homeFailure = message; this.options.warn(message); }
  }

  /** What the remote commands read: the live model and activity, and pi-multi-account's cached quota. */
  commandState(): CommandState {
    const { model, failover, now, models, select, abort, economy, thinking, setThinking, proactivityPaused, remoteLogin } = this.options;
    return { model, activity: () => this.activity, failover, now, models, select, abort, economy, thinking, setThinking, proactivityPaused,
      ...(remoteLogin ? { login: (arg: string) => this.runLoginCommand(arg) } : {}),
      recap: () => { const owner = this.owner(); return owner ? awayRecap(owner.dir, now()) : 'Perfil indisponível.'; }, wakeRefusals: ts => {
      const owner = this.owner();
      if (!owner) return 'Perfil indisponível.';
      if (ts) return revokeRefusal(owner.dir, ts) ? 'Assunto liberado.' : 'Recusa não encontrada.';
      const rules = activeRefusals(owner.dir, now());
      return rules.length ? `*Assuntos recusados:*\n${rules.map(r => `• ${r.channel}:${r.ts}: ${r.topic}`).join('\n')}\nPara liberar: *recusas ID*.` : 'Nenhum assunto recusado ativo.';
    } };
  }

  private async runLoginCommand(arg: string): Promise<{ text: string; choices?: readonly string[] }> {
    const login = this.options.remoteLogin!;
    const failover = this.options.failover() as { invalidatedByProvider?: Record<string, unknown> } | undefined;
    const invalidated = failover?.invalidatedByProvider && typeof failover.invalidatedByProvider === 'object'
      ? Object.keys(failover.invalidatedByProvider) : [];
    const resolved = login.resolveAccount(arg, this.options.models().map(m => m.provider), invalidated);
    if ('provider' in resolved) return login.start(resolved.provider, { reason: 'manual' });
    const choices = resolved.candidates.length >= 2 && resolved.candidates.length <= 5
      ? resolved.candidates.map(id => `login ${id}`) : undefined;
    return { text: resolved.message, ...(choices ? { choices } : {}) };
  }

  private resumeAfterLogin(prompt: ResumePrompt): void {
    this.threads.set(prompt.text, {
      thread: prompt.thread,
      channel: prompt.channel,
      ...(prompt.id ? { id: prompt.id } : {}),
      ...(prompt.ts ? { ts: prompt.ts } : {}),
      promptText: prompt.text,
    });
    this.pi.sendUserMessage(prompt.text, { deliverAs: 'steer' });
  }

  async handleBackgroundLogin(event: LoginCompletionEvent): Promise<void> {
    if (!this.owner()) return;
    await this.send(event.text).catch(error => {
      this.options.warn(`Slack login completion not sent: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.answered(null);
    this.refreshHome();
    if (event.ok && event.resumePrompt) this.resumeAfterLogin(event.resumePrompt);
  }

  async notifyAuthInvalidated(event: { provider?: unknown; reason?: unknown; at?: unknown }): Promise<void> {
    const provider = typeof event.provider === 'string' && event.provider ? event.provider : undefined;
    if (!provider || !this.owner()) return;
    const login = this.options.remoteLogin;
    if (login?.activeProvider === provider) return;
    const now = this.options.now();
    const at = typeof event.at === 'number' ? event.at : now;
    const prev = this.loginNotices.get(provider);
    if (prev && (prev.at === at || now - prev.notifiedAt < 10 * 60_000)) return;
    this.loginNotices.set(provider, { at, notifiedAt: now });
    this.refreshHome();
    const label = accountLabel(provider);
    if (login?.canRemoteLogin(provider)) {
      await this.send(
        `🔐 *${label}* (\`${provider}\`) perdeu o login e saiu da rotação. Toque abaixo ou mande *login ${provider}* para reconectar.`,
        null, null, { choices: [`login ${provider}`, 'status'] },
      ).catch(error => {
        this.options.warn(`Slack auth invalidation notice not sent: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    await this.send(
      `🔐 *${label}* (\`${provider}\`) teve a autenticação recusada e saiu da rotação. Atualize no terminal com \`/login\`.`,
    ).catch(error => {
      this.options.warn(`Slack auth invalidation notice not sent: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Answers a remote command in the DM; an effect it asks to confirm goes out as an approval post first. */
  private async command({ command, arg }: NonNullable<ReturnType<typeof remoteCommand>>): Promise<void> {
    const result = await command.run(this.commandState(), arg);
    if (!result.confirm) {
      await this.send(result.text, null, null, result.choices ? { choices: result.choices } : {});
      this.answered(null);
      this.refreshHome();
      return;
    }
    const { summary, apply } = result.confirm;
    let ran = false;
    const posted = await this.askApproval({
      token: `cmd-${randomUUID()}`, label: `Comando *${command.name}*`, summary: `${result.text} ${summary}`.slice(0, 500), expires: this.options.now() + COMMAND_APPROVAL_MS,
      decide: () => !ran && (ran = true),
      onPhone: async approve => approve ? apply() : `Negado: continuo em ${this.options.model() ?? 'nenhum modelo'}.`,
    });

    if (!posted) await this.send(`Não consegui postar o Aprovar no Slack; nada mudou, continuo em ${this.options.model() ?? 'nenhum modelo'}. Tente de novo ou use /approve no terminal.`).catch(() => {});
    this.answered(null);
  }

  /** Called for every user message of a run; a `[Slack]` one makes this run answer where it came from. */
  sawUserMessage(text: string, message?: AgentMessage): void {
    const match = FROM_SLACK.exec(text);
    const resumed = this.cutWake && !wakeTask(text) && PROVIDER_RESUME.test(text) && this.options.now() - this.cutWake.endedAt <= RESUME_WINDOW_MS ? this.cutWake : undefined;
    this.cutWake = undefined;
    const wake = wakeTask(text) !== undefined || resumed !== undefined;
    const about = wake ? 'turno automático (wake)' : text.replace(FROM_SLACK, '').replace(MID_RUN, '').split('\n')[0]!.slice(0, 300);

    if (!this.work || match) {
      this.work = { since: this.work?.since ?? resumed?.since ?? this.options.now(), origin: wake ? 'wake' : match ? 'Slack' : 'terminal', about, step: this.work?.step ?? '', stepSince: this.work?.stepSince ?? this.options.now(), steps: this.work?.steps ?? 0, shown: 0, headline: this.work?.headline ?? '', counts: this.work?.counts ?? noCounts() };
      this.showWork();
    }
    if (wake) { this.waking = true; if (!resumed) this.wakeTopic = wakeTask(text) ?? ''; return; }

    if (text.startsWith(CLAIM_CHECK_PREFIX)) return;
    if (FROM_WHATSAPP.test(text)) this.whatsapp = true;
    if (SHELL_END.test(text)) this.shellEnd = true;
    this.progressOnly = (this.progressOnly ?? true) && !match && WORKER_PROGRESS.test(text);
    if (!match) {

      if (this.answering && this.replied && this.replied !== this.delivered) {
        this.cancelTaskThread();
        this.delivered = this.replied;
        void this.answer(this.answering, this.replied, false);
      }
      return;
    }
    const origin = this.threads.get(text) ?? { thread: null, channel: match[1] ?? null };
    this.threads.delete(text);
    if (message && origin.id && origin.ts) this.loggedOrigins.set(message, slackMemoryKey(origin.id, origin.ts));
    if (this.answering?.startText !== undefined) return;
    this.answering = origin;
    this.scheduleTaskThread(origin);
  }

  private scheduleTaskThread(origin: Origin): void {
    const { ts, startText } = origin;
    if (!this.running || !ts || startText === undefined) return;
    this.taskThreadTimer = setTimeout(() => {
      this.taskThreadTimer = undefined;
      if (!this.running || this.answering !== origin) return;
      const scrubbed = scrubSecrets(startText);
      const summary = replyLead(scrubbed, 120).replace(/\s+/g, ' ');
      const plain = summary.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      origin.opening = this.publish(`Comecei: ${plain || 'tarefa com anexo'}`, ts, null).then(() => ts, error => {
        this.options.warn(`Slack task start not confirmed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    }, this.options.taskThreadAfterMs?.() ?? TASK_THREAD_AFTER_MS);
    this.taskThreadTimer.unref?.();
  }

  private cancelTaskThread(): void {
    clearTimeout(this.taskThreadTimer);
    this.taskThreadTimer = undefined;
  }

  /** Undefined means the session changed: send to the same profile without reusing any thread. */
  private async waitForTaskStart(opening: Promise<string | null>): Promise<string | null | undefined> {
    const generation = this.generation, dir = this.owner()?.dir;
    const thread = await opening;
    if (!dir || this.owner()?.dir !== dir) throw new Error('Slack profile changed before delivery.');
    return generation === this.generation ? thread : undefined;
  }

  private async progressThread(channel: string | null): Promise<string | null> {
    const origin = this.answering;
    if (!origin || origin.channel !== channel) return null;
    const confirmed = origin.opening ? await this.waitForTaskStart(origin.opening) : origin.thread;
    if (confirmed === undefined) return null;
    const canUseParent = (origin.channel === null || origin.id) && (!origin.opening || origin.threaded);
    const thread = confirmed ?? (canUseParent ? origin.ts ?? null : null);
    if (thread) origin.threaded = true;
    return thread;
  }

  /** At the end of a run that received a Slack message, its final answer goes back to the DM. */
  /** Every finished assistant message: a text-only one is the reply so far to the Slack message of this run. */
  assistantSaid(message: AgentMessage): void {
    if (message.role !== 'assistant') return;
    const content = (message as { content?: unknown }).content;
    if (this.running && this.work) this.work.headline = latestHeadline(this.work.headline, content);
    if (!this.answering) return;
    if (Array.isArray(content) && content.some(part => (part as { type?: string })?.type === 'toolCall')) return;
    const text = withoutCompactionBlocks(textContent(message.content, false));
    if (text) this.replied = text;
  }

  private async answer(answering: Origin, text: string, closing: boolean): Promise<void> {
    try {
      const parent = answering.opening ? await this.waitForTaskStart(answering.opening) : answering.thread;
      const legacyProgress = answering.threaded && parent === null;
      await this.publish(text, legacyProgress ? answering.ts ?? null : parent ?? null, answering.channel, legacyProgress ? { broadcast: true } : {});
      this.answered(answering.channel);
      const owner = this.owner();
      if (closing && owner && answering.id && answering.ts) { this.react(owner, answering.id, answering.ts, SEEN, true); this.react(owner, answering.id, answering.ts, DONE); }
    }
    catch (error) {
      const warning = closing ? 'Slack final answer not sent' : 'Slack reply not sent';
      this.options.warn(`${warning}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async answerDuringHold(): Promise<void> {
    const answering = this.answering, text = this.replied;
    if (!answering || !text) return;
    this.cancelTaskThread();
    this.answering = undefined; this.replied = ''; this.delivered = '';
    await this.answer(answering, text, true);
  }

  /** `quiet`: a wake that delivered nothing (heartbeat-report silentWake): its effects reach the wake log, its text reaches nobody; an `unverified` warning still does. */
  async runEnded(messages: readonly AgentMessage[], unverified?: string, quiet = false): Promise<void> {
    const answering = this.answering, waking = this.waking, delivered = this.delivered, whatsapp = this.whatsapp, progressOnly = this.progressOnly === true, shellEnd = this.shellEnd;
    this.progressOnly = undefined; this.shellEnd = false;
    this.answering = undefined; this.waking = false; this.whatsapp = false; this.replied = ''; this.delivered = '';
    this.running = false;
    this.cancelTaskThread();
    clearTimeout(this.workTimer); this.workTimer = undefined;
    const steps = this.work?.steps ?? 0, work = this.work, owner = this.owner();
    this.work = undefined;
    this.cutWake = waking ? { since: work?.since ?? this.options.now(), endedAt: this.options.now() } : undefined;
    if (work && steps && owner) try { recordRun(owner.dir, { start: work.since, end: this.options.now(), about: work.about, origin: work.origin, steps }); } catch {   }
    const hushed = quiet && waking && !answering && !unverified;
    const last = hushed ? '' : unverified ? `${unverified}${finalText(messages) ? `\n\n${finalText(messages)}` : ''}` : finalText(messages);
    this.home(`\u2705 *Livre* desde ${clock(this.options.now())}${steps ? ` · último trabalho: ${steps} passo${steps === 1 ? '' : 's'}` : ''}${last ? `\n\u00daltima resposta: ${replyLead(last)}` : ''}`);
    if (answering) {
      this.lastSlack = { origin: { ...answering, threaded: false }, at: this.options.now() };

      if (last && last === delivered) return;
      let reply = last;
      if (!reply) {
        const authFail = authFailureFromMessages(messages, this.options.model()?.split('/')[0]);
        if (authFail && this.options.remoteLogin) {
          const resumePrompt: ResumePrompt | undefined = answering.promptText
            ? { text: answering.promptText, thread: answering.thread, channel: answering.channel, ...(answering.id ? { id: answering.id } : {}), ...(answering.ts ? { ts: answering.ts } : {}) }
            : undefined;
          const step = await this.options.remoteLogin.handleAuthFailure(authFail.provider, authFail.errorMessage, resumePrompt);
          reply = step.text;
        } else if (authFail) {
          const label = authFail.provider ? `*${accountLabel(authFail.provider)}* (\`${authFail.provider}\`)` : 'a conta atual';
          reply = `🔐 *Sessão expirada em ${label}.* Mande *login* aqui na DM ou rode \`/login\` no terminal para reconectar.`;
        }
      }
      await this.answer(answering, reply || failure(messages) || EMPTY_RUN, true);
      return;
    }
    const followUp = this.lastSlack && this.options.now() - this.lastSlack.at <= SHELL_FOLLOW_UP_MS ? this.lastSlack.origin : undefined;
    if (!waking && shellEnd && !whatsapp && followUp && last) { await this.answer(followUp, last, false); return; }
    if (!waking) {
      let text = whatsapp || !this.options.everyAnswer?.() ? '' : progressOnly ? failure(messages) : last || failure(messages);
      if (!whatsapp && this.options.everyAnswer?.() && !last) {
        const authFail = authFailureFromMessages(messages, this.options.model()?.split('/')[0]);
        if (authFail && this.options.remoteLogin) {
          const step = await this.options.remoteLogin.handleAuthFailure(authFail.provider, authFail.errorMessage);
          text = step.text;
        } else if (authFail) {
          const label = authFail.provider ? `*${accountLabel(authFail.provider)}* (\`${authFail.provider}\`)` : 'a conta atual';
          text = `🔐 *Sessão expirada em ${label}.* Mande *login* aqui na DM ou rode \`/login\` no terminal para reconectar.`;
        }
      }
      if (text) try { await this.publish(text, null, null); this.answered(null); }
      catch (error) { this.options.warn(`Answer not sent to Slack: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    const text = last;


    const council = councilThread(messages), topic = text.trim().replace(/^(?:proponho|sugiro)\s+/i, '').replace(/[.!?]+$/, '') || this.wakeTopic;
    this.wakeTopic = '';
    try {
      const post = await this.publish(wakeLogPost({ start: work?.since ?? this.options.now(), end: this.options.now(), steps, messages, report: text }), council ?? null, WAKE_LOG_CHANNEL, council ? { broadcast: true } : {});
      if (owner && !council && post.channel) try { for (const ts of post.timestamps ?? [post.ts]) rememberWake(owner.dir, post.channel, ts, topic, this.options.now()); }
      catch (error) { this.options.warn(`Wake post not recorded: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Unknown Slack channel'))) { this.options.warn(`Wake log not sent to Slack: ${error instanceof Error ? error.message : String(error)}`); return; }
    }
    const channel = text ? wakeChannel(messages) : undefined;
    if (!text || channel === undefined) return;
    try {
      const post = await this.publish(`*Wake* · ${text}`, null, channel);
      if (owner && post.channel) try { for (const ts of post.timestamps ?? [post.ts]) rememberWake(owner.dir, post.channel, ts, topic, this.options.now()); }
      catch (error) { this.options.warn(`Wake post not recorded: ${error instanceof Error ? error.message : String(error)}`); }
    } catch (error) { this.options.warn(`Wake report not sent to Slack: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Posts a gated call to the operator's DM with Aprovar/Negar buttons; a tap (relayed by the service as that reply) or
   * their `aprovar`/`negar` in its thread decides it. Best effort: the terminal `/approve` keeps working when Slack is down.
   */
  async askApproval(request: ApprovalRequest): Promise<boolean> {
    const now = this.options.now();
    for (const [ts, post] of this.approvals) if (post.request.expires <= now) this.approvals.delete(ts);
    const minutes = Math.max(1, Math.round((request.expires - now) / 60_000));
    const full = request.detail ? `\`\`\`${request.detail.replaceAll('```', '`\u200b``')}\`\`\`\n` : '';
    const why = `${request.reason ? `*Motivo:* ${request.reason}\n` : ''}${request.targets?.length ? `*Alvo:* ${request.targets.slice(0, 5).map(t => `\`${t}\``).join(', ')}${request.targets.length > 5 ? ` e mais ${request.targets.length - 5}` : ''}\n` : ''}`;
    const head = `⏸ *Aprovação pendente* · ${request.label}: ${request.summary}\n${why}${full}`, tail = `(vale ${minutes} min). Aprova só esta chamada, uma vez.`;
    const session = request.sessionAllow && request.allowSession ? request.sessionAllow : undefined;
    const scope = session ? `\n*Aprovar nesta sessão* libera só \`${session}\` até a sessão reiniciar; deploy, produção, gastos, mensagens a terceiros e credenciais continuam pedindo a cada chamada.\n` : ' ';
    try {
      let ts: string, channel: string | undefined;
      try { ({ ts, channel } = await this.send(`${head}Toque em *Aprovar* ou *Negar*, ou responda *aprovar*/*negar* nesta thread ${tail}${session ? scope.trimEnd() : ''}`, null, null, { approval: true, ...(session ? { sessionAllow: session } : {}) })); }
      catch (error) {

        if (!refused(error)) throw error;
        ({ ts, channel } = await this.send(`${head}Responda *aprovar* ou *negar* nesta thread ${tail}`));
      }
      this.approvals.set(ts, { request, channel: typeof channel === 'string' ? channel : null });
      this.refreshHome();
      this.options.schedule(() => void this.settled(request.token, 'expired'), Math.max(0, request.expires - now));
      return true;
    } catch (error) { this.options.warn(`Approval not posted to Slack: ${error instanceof Error ? error.message : String(error)}`); return false; }
  }

  /** The call of an approval post stopped waiting outside Slack (terminal, a newer call, expiry): the post says so. */
  settled(token: string, outcome: Settled, via?: string): Promise<unknown> {
    const found = [...this.approvals].find(([, post]) => post.request.token === token);
    if (!found) return this.settling;
    this.approvals.delete(found[0]);
    this.refreshHome();
    const where = via && (outcome === 'approved' || outcome === 'denied') ? `${outcome === 'approved' ? '\u2705 *Aprovado' : '\u{1f6ab} *Negado'} no ${via}*` : undefined;
    return this.retire(found[0], found[1], outcome, where);
  }

  /** Settles pending post rewrites (tests). */
  idle(): Promise<unknown> { return this.settling; }

  /** Rewrites the post without its buttons; a service without `update` (or a post without its DM id) gets a thread reply. */
  private retire(ts: string, { request, channel }: Post, outcome: keyof typeof SETTLED_TEXT, head = SETTLED_TEXT[outcome]): Promise<unknown> {
    const text = `${head} \u00b7 ${request.label}: ${request.summary}`;
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

  private async decided(ts: string, approve: boolean, session = false): Promise<void> {
    const post = this.approvals.get(ts)!, { request } = post;
    if (session && !(request.sessionAllow && request.allowSession)) {
      try { await this.send('Essa chamada n\u00e3o aceita libera\u00e7\u00e3o de sess\u00e3o; responda *aprovar* ou *negar*.', ts); } catch {   }
      return;
    }
    this.approvals.delete(ts);
    this.refreshHome();
    const done = request.expires > this.options.now() && (session ? request.allowSession!() : request.decide(approve));
    if (done) await this.retire(ts, post, session ? 'phone-session' : approve ? 'phone-approved' : 'phone-denied');
    if (done && request.onPhone) {
      let reply: string;
      try { reply = await request.onPhone(approve); } catch (error) { reply = `Falhou: ${error instanceof Error ? error.message : String(error)}`; }
      try { await this.send(reply, ts); } catch {   }
      return;
    }
    const reply = !done ? 'Essa aprovação já expirou ou foi decidida; nada rodou por ela.' : session ? `Aprovado e liberado nesta sess\u00e3o (s\u00f3 \`${request.sessionAllow}\`): ${request.summary}. Vou rodar agora.` : approve ? `Aprovado: ${request.summary}. Vou rodar agora.` : `Negado: ${request.summary}. Não vou rodar.`;
    try { await this.send(reply, ts); } catch {   }
    if (!done) return;
    const note = session ? `aprovou no celular e liberou nesta sess\u00e3o s\u00f3 \`${request.sessionAllow}\`: ${request.summary}. Rode de novo exatamente a mesma chamada.` : approve ? `aprovou no celular: ${request.summary}. Rode de novo exatamente a mesma chamada, uma vez.` : `negou no celular: ${request.summary}. Não rode nem tente de novo.`;
    this.pi.sendUserMessage(`${SLACK_PREFIX}(aprovação) O operador ${note}`, { deliverAs: 'steer' });
  }

  /**
   * Posts under a topic: the first post of a `topic` opens a message in the channel, later ones reply in its thread,
   * so one subject (a PR, a long task) keeps its history together. Topics last two weeks.
   */
  async post(text: string, channel: string | null, topic?: string, options: { broadcast?: true; choices?: readonly string[] } = {}): Promise<{ parts: number; ts: string; thread: string }> {
    const owner = this.owner();
    const sameChannel = this.answering?.channel === channel;
    const choices = options.choices ? { choices: options.choices } : {};
    if (!topic || !owner) {
      const thread = await this.progressThread(channel);
      const broadcast = options.broadcast && !thread && sameChannel ? true : undefined;
      const sent = await this.publish(text, thread, channel, broadcast ? { ...choices, broadcast } : choices);
      return { ...sent, thread: thread ?? sent.ts };
    }
    const file = join(owner.dir, TOPICS), now = this.options.now();
    let topics: Record<string, { channel: string | null; ts: string; at: number }> = {};
    try { topics = JSON.parse(readFileSync(file, 'utf8')); } catch {   }
    const known = topics[topic];
    const open = known && known.channel === channel && now - known.at < TOPIC_DAYS * 86_400_000 ? known : undefined;
    const broadcast = (open || sameChannel) && options.broadcast;
    const result = await this.publish(text, open?.ts ?? null, channel, broadcast ? { ...choices, broadcast } : choices);
    if (!open) {
      topics[topic] = { channel, ts: result.ts, at: now };
      const fresh = Object.entries(topics).filter(([, t]) => now - t.at < TOPIC_DAYS * 86_400_000).slice(-300);
      atomicWrite(file, JSON.stringify(Object.fromEntries(fresh)));
    }
    return { ...result, thread: open?.ts ?? result.ts };
  }

  /**
   * A slack_send: without a channel it goes where the work is (the project of its topic, else of the repos this run
   * touched), unless the run answers his DM; `dm` forces the DM. A reply in a thread also shows in the conversation,
   * so he sees every report without opening threads.
   */
  async report(text: string, channel?: string, topic?: string, files: readonly string[] = [], choices?: readonly string[]): Promise<{ channel: string | null }> {
    const to = channel === 'dm' ? null : channel ?? this.workChannel(topic);
    const { thread } = await this.post(text, to, topic, { broadcast: true, ...(choices ? { choices } : {}) });
    for (const path of files) await this.attach(path, thread, to);
    return { channel: to };
  }

  /** A picture or PDF under the post that explains it, in the same thread. */
  private async attach(path: string, threadTs: string, channel: string | null): Promise<void> {
    const owner = this.owner();
    if (!owner) throw new Error('No active profile.');
    try { await this.options.request(owner, '/v1/slack/upload', { path, threadTs, ...(channel ? { channel } : {}) }); }
    catch (error) {

      const why = error instanceof HttpError && error.status === 502 ? 'Slack or the service refused it (only png, jpg, gif, webp or pdf up to 10 MB at an absolute path; the Slack app needs the files:write scope)' : error instanceof Error ? error.message : String(error);
      throw new Error(`The message was sent, but the file ${path} was not: ${why}`);
    }
  }

  private workChannel(topic?: string): string | null {
    if (this.answering) return this.answering.channel;
    return (topic ? projectOfRepo(topic) : undefined) ?? projectOf(...this.touched) ?? null;
  }

  /** A post the agent wants to make (a final answer, a wake report, slack_send): always one whole message. */
  private async publish(text: string, threadTs: string | null, channel: string | null, options: { broadcast?: true; choices?: readonly string[] } = {}): Promise<{ parts: number; ts: string; channel?: string; timestamps?: string[] }> {
    return this.send(text, threadTs, channel, options);
  }

  /** The plan card last posted in the DM, so a later send of the same plan updates it. */
  private planCard: { shape: string; ts: string; channel: string } | undefined;

  /** To the operator's DM, or with `channel` to that configured project channel. */
  async send(text: string, threadTs: string | null = null, channel: string | null = null, options: { approval?: true; broadcast?: true; sessionAllow?: string; choices?: readonly string[] } = {}): Promise<{ parts: number; ts: string; channel?: string; timestamps?: string[] }> {
    const owner = this.owner();
    if (!owner) throw new Error('No active profile.');
    try {
      const plan = channel === null && !threadTs ? extractPlan(text) : undefined;
      const card = plan && this.planCard?.shape === planShape(plan.plan) ? this.planCard : undefined;
      if (card && plan && canCard(plan)) {
        const moved = await this.options.request(owner, '/v1/slack/plan', { channel: card.channel, ts: card.ts, text }).then(() => true, () => false);
        if (moved) {
          this.options.sent(channel, text);
          return { parts: 1, ts: card.ts, channel: card.channel };
        }
        this.planCard = undefined;
      }
      const result = await this.options.request(owner, '/v1/slack/send', { text, threadTs, ...(channel ? { channel } : {}), ...options }) as { parts: number; ts: string; channel?: string; timestamps?: string[] };
      if (plan && canCard(plan) && result.ts && result.channel && /^D/.test(result.channel)) this.planCard = { shape: planShape(plan.plan), ts: result.ts, channel: result.channel };
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
  options: { request?: Request; accepting?: () => boolean; nextWake?: () => number | undefined; items?: () => HomeWork; wordBudgets?: WordBudgets; deferEnd?: boolean; economy?: () => Economy | undefined; everyAnswer?: () => boolean; proactivityPaused?: () => boolean; onInbound?: (channel: string | null, at: number) => void; taskThreadAfterMs?: () => number | undefined; memoryUndo?: (command: UndoCommand) => string; remoteLogin?: RemoteLoginManager } = {}): SlackBridge {
  let abort: () => boolean = () => false;
  let warn: (text: string) => void = () => {};
  let model: string | undefined;
  const named = (m: { provider: string; id: string } | undefined) => m ? `${m.provider}/${m.id}` : undefined;
  let registry: { getAvailable(): readonly ModelRef[]; find(provider: string, id: string): unknown; authStorage?: AuthStorageLike } | undefined;
  let selected: Parameters<typeof getSupportedThinkingLevels>[0] | undefined;
  const ownsLogin = !options.remoteLogin;
  const remoteLogin = options.remoteLogin ?? new RemoteLoginManager({
    authStorage: () => registry?.authStorage,
    onUpdated: (provider, meta) => pi.events?.emit?.('pi:auth:updated:v1', { provider, skipPendingResume: meta.skipPendingResume }),
    onBackgroundComplete: event => { void bridge.handleBackgroundLogin(event); },
  });
  const bridge = new SlackBridge(pi, owner, {
    warn: text => warn(text), sent, model: () => model, abort: () => abort(),
    thinking: () => selected ? { level: pi.getThinkingLevel(), levels: getSupportedThinkingLevels(selected) } : undefined,

    setThinking: level => { pi.setThinkingLevel(level as never); return pi.getThinkingLevel(); },
    models: () => registry?.getAvailable().map(m => ({ provider: m.provider, id: m.id })) ?? [],

    select: async ({ provider, id }) => { const found = registry?.find(provider, id); return found ? pi.setModel(found as never) : false; },
    remoteLogin,
    ...options,
  });
  let unsubInvalidated: (() => void) | undefined;
  pi.on('session_start', (_event, ctx) => {
    abort = () => { if (ctx.isIdle()) return false; ctx.abort(); return true; };
    warn = text => ctx.ui.notify(text, 'warning');
    model = named(ctx.model); selected = ctx.model; registry = ctx.modelRegistry as typeof registry;
    unsubInvalidated?.();
    const unsub = pi.events?.on?.('pi:auth:invalidated:v1', payload => {
      void bridge.notifyAuthInvalidated((payload ?? {}) as { provider?: unknown; reason?: unknown; at?: unknown });
    });
    unsubInvalidated = typeof unsub === 'function' ? unsub : undefined;
    bridge.start();
  });

  pi.on('model_select', event => { model = named(event.model); selected = event.model; });
  pi.on('session_shutdown', () => { unsubInvalidated?.(); unsubInvalidated = undefined; if (ownsLogin) remoteLogin.stop(); bridge.stop(); });
  pi.on('message_end', ({ message }) => { const text = promptText(message); if (text !== undefined) bridge.sawUserMessage(text, message); else bridge.assistantSaid(message); });
  pi.on('agent_start', () => bridge.runStarted(options.deferEnd));
  pi.on('tool_execution_start', event => bridge.toolStarted(event.toolName, event.args));
  pi.on('agent_end', event => { if (!options.deferEnd) return bridge.runEnded(event.messages); });
  pi.registerTool({
    name: 'slack_send', label: 'Message the operator on Slack',
    description: "Send a message to the operator on Slack; they read it on the phone. Use it to report finished work, progress on long tasks and blockers that need their decision, especially when they may be away; never post shell or subagent completions (commands, exit codes, test output), only what the work delivered. `channel` posts to a project channel: dentai (dentai-mono), genexus18mcp (Genexus18MCP), harness (pi-optchat, pi-subagents, pi-goal-x, pi-multi-account, pi-ripwire, dotfiles), or `dm` for the DM. Omitted, it goes to the project of the topic, else of the repos this run touched, else the DM; during a run started by his DM it answers there. Pass `dm` for general matters, urgent blockers and decisions. A post under a known topic replies in its thread and also shows in the conversation. A [Slack] or [Slack #channel] message that arrives while you are working: answer it here (same channel) and keep working, since a text-only reply ends the run. When the run started from a Slack message, its final answer goes back automatically: don't repeat it here. Keep each message within the channel's word budget (100 words by default); it always goes out whole, in one message. Style: open with the key outcome in **bold**, cite PRs and links as [PR #42](url) instead of bare URLs, at most 5 flat bullets, number options when asking for a choice; no Markdown tables.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 20000 }),
      channel: Type.Optional(Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,79}$', description: 'Project channel name without #, or dm; omit to follow the work.' })),
      files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 4, description: 'Absolute paths of pictures or PDFs (png, jpg, gif, webp, pdf; 10 MB each) to attach under the message, e.g. a screenshot of finished work.' })),
      choices: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 75 }), { minItems: 2, maxItems: 5, description: 'One-tap answer buttons under the message (2-5 short labels, the recommended one first; a denial such as "N\u00e3o" or "Parar" shows in red). The tap comes back as his reply. Use when you ask him to pick.' })),
      topic: Type.Optional(Type.String({ pattern: '^[\\w.#:/-]{1,80}$', description: 'Short key of the task this post belongs to (e.g. denta-106, gx-issue-701). The first post with a topic opens it; later posts with the same topic reply in its thread.' })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const { channel } = await bridge.report(params.text, params.channel, params.topic, params.files, params.choices);
      bridge.answered(channel);
      return { content: [{ type: 'text', text: `Sent to ${channel ? `Slack #${channel}` : "the operator's Slack DM"}.` }], details: undefined };
    },
  });
  return bridge;
}
