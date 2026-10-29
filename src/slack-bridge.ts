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
 * Pi marks these messages as extension input, so a Slack message can never approve a gated effect.
 */
export const SLACK_PREFIX = '[Slack] ';
export type SlackOwner = { dir: string; name: string };
type Inbound = { seq: number; ts: string; thread: string | null; text: string };
type Request = (owner: SlackOwner, path: string, body?: unknown) => Promise<unknown>;
const CURSOR = 'slack-cursor.json';
const OFF_FOR_MS = 5 * 60_000;
const EMPTY_RUN = 'Recebi, mas a execução terminou sem resposta em texto (erro ou interrupção). Manda de novo se precisar.';
/** A DM steered into a working run: a text-only reply would end the run and stop the work. */
const MID_RUN = '\n\n(Arrived while you were working: answer it with slack_send, then continue the current work. Do not end the run just to reply.)';

const defaultRequest: Request = (owner, path, body) => assistantRequest(assistantConfig(owner), path, body, 20_000);

function finalText(messages: readonly AgentMessage[]): string {
  const last = [...messages].reverse().find(m => m.role === 'assistant');
  return last ? textContent(last.content, false).trim() : '';
}

export class SlackBridge {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private offUntil = 0;
  /** Set when a `[Slack]` message entered the current run: its final answer goes back to the DM. */
  private answering: { thread: string | null } | undefined;
  private running = false;
  private readonly threads = new Map<string, string | null>();
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
  stop(): void { clearInterval(this.timer); this.answering = undefined; this.running = false; }
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
        const text = `${SLACK_PREFIX}${m.text}${this.running ? MID_RUN : ''}`;
        this.threads.set(text, typeof m.thread === 'string' ? m.thread : null);
        this.pi.sendUserMessage(text, { deliverAs: 'steer' });
        atomicWrite(join(owner.dir, CURSOR), JSON.stringify({ seq: m.seq }));
        delivered++;
      }
      return delivered;
    } finally { this.polling = false; }
  }

  /** Called for every user message of a run; a `[Slack]` one makes this run answer in the DM. */
  sawUserMessage(text: string): void {
    if (!text.startsWith(SLACK_PREFIX)) return;
    this.answering = { thread: this.threads.get(text) ?? null };
    this.threads.delete(text);
  }

  /** At the end of a run that received a Slack message, its final answer goes back to the DM. */
  async runEnded(messages: readonly AgentMessage[]): Promise<void> {
    const answering = this.answering;
    this.answering = undefined;
    this.running = false;
    if (!answering) return;
    try { await this.send(finalText(messages) || EMPTY_RUN, answering.thread); }
    catch (error) { this.options.warn(`Slack reply not sent: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async send(text: string, threadTs: string | null = null): Promise<{ parts: number; ts: string }> {
    const owner = this.owner();
    if (!owner) throw new Error('No active profile.');
    try { return await this.options.request(owner, '/v1/slack/send', { text, threadTs }) as { parts: number; ts: string }; }
    catch (error) {
      if (error instanceof HttpError) throw new Error(error.status === 404 ? 'The assistant service has no Slack chat (no bot token configured).' : error.status === 503 ? 'Slack bot token not configured.' : `Slack send failed (HTTP ${error.status}).`);
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
    description: "Send a message to the operator's Slack DM; they read it on the phone. Use it to report finished work, progress on long tasks, background results and blockers that need their decision, especially when they may be away. A [Slack] message that arrives while you are working: answer it here and keep working, since a text-only reply ends the run. When the run started from a [Slack] message, its final answer goes back automatically: don't repeat it here.",
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 20000 }) }, { additionalProperties: false }),
    async execute(_id, params) {
      const result = await bridge.send(params.text);
      return { content: [{ type: 'text', text: `Sent to the operator's Slack DM (${result.parts} part${result.parts === 1 ? '' : 's'}).` }], details: undefined };
    },
  });
  return bridge;
}
