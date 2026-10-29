import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { assistantConfig, assistantRequest, HttpError } from './assistant-client.ts';
import { atomicWrite } from './store.ts';
import { textContent } from './transcript.ts';

/**
 * The operator's Slack DM as a second door into this chat. The assistant service queues the operator's DMs; this
 * bridge polls them over the loopback API, hands each to the agent as a user message marked `[Slack]`, and posts the
 * run's final answer back to the DM. `slack_send` lets the agent write first (progress, finished work, a blocker).
 * A heartbeat wake that delivered something (an edit, commit, push or PR) posts its final answer to that repo's channel.
 * Pi marks these messages as extension input, so a Slack message can never approve a gated effect.
 */
export const SLACK_PREFIX = '[Slack] ';
/** `[Slack] ` for the DM, `[Slack #dentai] ` for a project channel. */
const slackPrefix = (channel: string | null) => channel ? `[Slack #${channel}] ` : SLACK_PREFIX;
export const FROM_SLACK = /^\[Slack(?: #([a-z0-9][a-z0-9_-]{0,79}))?\] /;
export type SlackOwner = { dir: string; name: string };
type Inbound = { seq: number; ts: string; thread: string | null; text: string; channelName?: string | null };
type Origin = { thread: string | null; channel: string | null };
type Request = (owner: SlackOwner, path: string, body?: unknown) => Promise<unknown>;
const CURSOR = 'slack-cursor.json';
const OFF_FOR_MS = 5 * 60_000;
const EMPTY_RUN = 'Recebi, mas a execução terminou sem resposta em texto (erro ou interrupção). Manda de novo se precisar.';
/** A DM steered into a working run: a text-only reply would end the run and stop the work. */
const MID_RUN = '\n\n(Arrived while you were working: answer it with slack_send, then continue the current work. Do not end the run just to reply.)';

const defaultRequest: Request = (owner, path, body) => assistantRequest(assistantConfig(owner), path, body, 20_000);
/** The two prompts a heartbeat wake starts with (heartbeat.ts wakeText). */
const WAKE = /^(?:A cheap check \([^)]*\) woke you|The operator's fixed \d+-min schedule woke you)/;
/** Repository folder under C:/projetos -> its Slack channel. */
const REPO_CHANNELS: [RegExp, string][] = [[/^dentai/i, 'dentai'], [/^genexus18mcp/i, 'genexus18mcp'], [/^(?:pi-|dotfiles$|ripwire$|local-validation$)/i, 'harness']];

type ToolCall = { name: string; arguments: unknown };
const toolCalls = (messages: readonly AgentMessage[]): ToolCall[] => messages.flatMap(m => m.role === 'assistant'
  ? m.content.flatMap(part => part.type === 'toolCall' ? [{ name: part.name, arguments: part.arguments }] : []) : []);
/** A call that changed something: a file edit, a commit, a push or a PR. Reads and checks deliver nothing. */
const delivers = (call: ToolCall) => call.name === 'edit' || call.name === 'write'
  || (call.name === 'bash' && /\bgit\s+(?:commit|push)\b|\bgh\s+pr\s+(?:create|merge)\b/.test(JSON.stringify(call.arguments)));

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
  const hits = new Map<string, number>();
  for (const call of delivering)
    for (const [, repo] of JSON.stringify(call.arguments).matchAll(/projetos[\\/]+([\w.-]+)/gi)) {
      const channel = REPO_CHANNELS.find(([pattern]) => pattern.test(repo!))?.[1];
      if (channel) hits.set(channel, (hits.get(channel) ?? 0) + 1);
    }
  return [...hits].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function finalText(messages: readonly AgentMessage[]): string {
  const last = [...messages].reverse().find(m => m.role === 'assistant');
  return last ? textContent(last.content, false).trim() : '';
}

export class SlackBridge {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private offUntil = 0;
  /** Set when a `[Slack]` message entered the current run: its final answer goes back to the DM. */
  private answering: Origin | undefined;
  /** Set when a heartbeat wake started the current run: what it delivered is reported to the repo's channel. */
  private waking = false;
  private running = false;
  private readonly threads = new Map<string, Origin>();
  private readonly options: { intervalMs: number; now: () => number; request: Request; warn: (text: string) => void };

  constructor(private readonly pi: Pick<ExtensionAPI, 'sendUserMessage'>, private readonly owner: () => SlackOwner | undefined,
    options: Partial<SlackBridge['options']> = {}) {
    this.options = { intervalMs: 3000, now: Date.now, request: defaultRequest, warn: () => {}, ...options };
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs);
    this.timer.unref?.();
  }
  stop(): void { clearInterval(this.timer); this.answering = undefined; this.waking = false; this.running = false; }
  runStarted(): void { this.running = true; }

  /** One pass: new DMs become user messages in order; the cursor advances only past delivered ones. */
  async poll(): Promise<number> {
    const owner = this.owner();
    if (!owner || this.polling || this.options.now() < this.offUntil) return 0;
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
        const text = `${slackPrefix(channel)}${m.text}${this.running ? MID_RUN : ''}`;
        this.threads.set(text, { thread: typeof m.thread === 'string' ? m.thread : null, channel });
        this.pi.sendUserMessage(text, { deliverAs: 'steer' });
        atomicWrite(join(owner.dir, CURSOR), JSON.stringify({ seq: m.seq }));
        delivered++;
      }
      return delivered;
    } finally { this.polling = false; }
  }

  /** Called for every user message of a run; a `[Slack]` one makes this run answer where it came from. */
  sawUserMessage(text: string): void {
    if (WAKE.test(text)) { this.waking = true; return; }
    const match = FROM_SLACK.exec(text);
    if (!match) return;
    this.answering = this.threads.get(text) ?? { thread: null, channel: match[1] ?? null };
    this.threads.delete(text);
  }

  /** At the end of a run that received a Slack message, its final answer goes back to the DM. */
  async runEnded(messages: readonly AgentMessage[]): Promise<void> {
    const answering = this.answering, waking = this.waking;
    this.answering = undefined; this.waking = false;
    this.running = false;
    if (answering) {
      try { await this.send(finalText(messages) || EMPTY_RUN, answering.thread, answering.channel); }
      catch (error) { this.options.warn(`Slack reply not sent: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    const text = waking && finalText(messages);
    const channel = text ? wakeChannel(messages) : undefined;
    if (!text || channel === undefined) return;
    try { await this.send(`*Wake* · ${text}`, null, channel); }
    catch (error) { this.options.warn(`Wake report not sent to Slack: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** To the operator's DM, or with `channel` to that configured project channel. */
  async send(text: string, threadTs: string | null = null, channel: string | null = null): Promise<{ parts: number; ts: string }> {
    const owner = this.owner();
    if (!owner) throw new Error('No active profile.');
    try { return await this.options.request(owner, '/v1/slack/send', { text, threadTs, ...(channel ? { channel } : {}) }) as { parts: number; ts: string }; }
    catch (error) {
      if (error instanceof HttpError) throw new Error(error.status === 404 ? 'The assistant service has no Slack chat (no bot token configured).' : error.status === 503 ? 'Slack bot token not configured.' : error.status === 400 && channel ? `Unknown Slack channel "${channel}": it is not in the service's slack.channels.` : `Slack send failed (HTTP ${error.status}).`);
      throw error;
    }
  }

  private cursor(owner: SlackOwner): number {
    try { const seq = (JSON.parse(readFileSync(join(owner.dir, CURSOR), 'utf8')) as { seq?: unknown }).seq; return Number.isSafeInteger(seq) ? seq as number : 0; }
    catch { return 0; }
  }
}

/** Wires the bridge into Pi: polling per session, replies at run end, and the `slack_send` tool. */
export function registerSlackBridge(pi: ExtensionAPI, owner: () => SlackOwner | undefined): SlackBridge {
  let warn: (text: string) => void = () => {};
  const bridge = new SlackBridge(pi, owner, { warn: text => warn(text) });
  pi.on('session_start', (_event, ctx) => { warn = text => ctx.ui.notify(text, 'warning'); bridge.start(); });
  pi.on('session_shutdown', () => bridge.stop());
  pi.on('message_end', event => { if (event.message.role === 'user') bridge.sawUserMessage(textContent(event.message.content, false)); });
  pi.on('agent_start', () => bridge.runStarted());
  pi.on('agent_end', event => bridge.runEnded(event.messages));
  pi.registerTool({
    name: 'slack_send', label: 'Message the operator on Slack',
    description: "Send a message to the operator on Slack; they read it on the phone. Use it to report finished work, progress on long tasks, background results and blockers that need their decision, especially when they may be away. `channel` posts to a project channel instead of the DM: dentai (dentai-mono), genexus18mcp (Genexus18MCP), harness (pi-optchat, pi-subagents, pi-goal-x, pi-multi-account, pi-ripwire, dotfiles); route reports by the repo the work is in, and keep the DM for general matters, urgent blockers and decisions. A [Slack] or [Slack #channel] message that arrives while you are working: answer it here (same channel) and keep working, since a text-only reply ends the run. When the run started from a Slack message, its final answer goes back automatically: don't repeat it here.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 20000 }),
      channel: Type.Optional(Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,79}$', description: 'Project channel name without #; omit for the DM.' })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const result = await bridge.send(params.text, null, params.channel ?? null);
      return { content: [{ type: 'text', text: `Sent to ${params.channel ? `Slack #${params.channel}` : "the operator's Slack DM"} (${result.parts} part${result.parts === 1 ? '' : 's'}).` }], details: undefined };
    },
  });
  return bridge;
}
