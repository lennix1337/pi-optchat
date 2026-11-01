import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { promptText } from './heartbeat.ts';
import { remoteCommand, type CommandState } from './remote-commands.ts';
import { finalText } from './slack-bridge.ts';
import { atomicWrite } from './store.ts';

/**
 * The operator's WhatsApp as another door into this chat, through wacli (https://wacli.sh), a CLI linked to his
 * WhatsApp as a device. wacli's own `sync --follow` keeps its local store current; this bridge only reads that store
 * (`--read-only`) and sends replies through it. It reads ONE chat and accepts only the operator there, so a message
 * from anyone else never reaches the agent, and it writes only to that same chat: never to a third party.
 * Commands (`status`, `cota`, `modelo`...) are answered here without a model turn, like on Slack; anything else becomes
 * a `[WhatsApp] ` user message whose run's final answer goes back to the chat. An account switch is not approved from
 * here: that stays on Slack's Aprovar or the terminal.
 *
 * Config: `~/.pi/agent/optchat-whatsapp.json` = { "wacli": "path/to/wacli.exe", "chat": "<chat JID>",
 *   "operator": "<sender JID>" | "self", "account"?: "<wacli named account>" }. "self" is his own "Message yourself"
 * chat, where his messages are FromMe; replies there use `--allow-self` (WhatsApp may not show them on the phone).
 * Without the file the bridge stays off.
 */
export const WHATSAPP_PREFIX = '[WhatsApp] ';
export const WHATSAPP_CONFIG = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'optchat-whatsapp.json');
/** Every reply starts with this, so the bridge never reads its own message back as the operator's (self chat). */
export const BOT_MARK = '\u{1f916} ';
const CURSOR = 'whatsapp-cursor.json';
const MAX_TEXT = 4000;

export type WhatsAppConfig = { wacli: string; chat: string; operator: string; account?: string };
type Message = { MsgID: string; ChatJID: string; SenderJID?: string; FromMe?: boolean; Text?: string; Timestamp: string };
export type Runner = (file: string, args: readonly string[]) => Promise<string>;

const defaultRunner: Runner = (file, args) => new Promise((resolve, reject) =>
  execFile(file, args as string[], { timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));

export function readWhatsAppConfig(file = WHATSAPP_CONFIG): WhatsAppConfig | undefined {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
  const c = raw as Partial<WhatsAppConfig>;
  const jid = (v: unknown) => typeof v === 'string' && /^[\w.:-]+@[\w.]+$/.test(v);
  if (typeof c.wacli !== 'string' || !jid(c.chat) || !(c.operator === 'self' || jid(c.operator))) return undefined;
  return { wacli: c.wacli, chat: c.chat!, operator: c.operator!, ...(typeof c.account === 'string' ? { account: c.account } : {}) };
}

export class WhatsAppBridge {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private answering = false;
  private readonly pending = new Set<string>();
  private readonly options: { intervalMs: number; run: Runner; now: () => number; warn: (text: string) => void; accepting: () => boolean };

  constructor(private readonly pi: Pick<ExtensionAPI, 'sendUserMessage'>, private readonly config: WhatsAppConfig, private readonly dir: () => string | undefined,
    private readonly state: () => CommandState, options: Partial<WhatsAppBridge['options']> = {}) {
    this.options = { intervalMs: 5000, run: defaultRunner, now: Date.now, warn: () => {}, accepting: () => true, ...options };
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.poll().catch(error => this.options.warn(`WhatsApp pass failed; it retries: ${error instanceof Error ? error.message : String(error)}`)), this.options.intervalMs);
    this.timer.unref?.();
  }
  stop(): void { clearInterval(this.timer); this.answering = false; }

  private args(...rest: string[]): string[] { return [...(this.config.account ? ['--account', this.config.account] : []), '--json', ...rest]; }

  /** The operator's own messages in the configured chat, never the bot's replies. */
  private fromOperator(m: Message): boolean {
    if (m.ChatJID !== this.config.chat || typeof m.Text !== 'string' || !m.Text.trim() || m.Text.startsWith(BOT_MARK.trim())) return false;
    return this.config.operator === 'self' ? m.FromMe === true : m.FromMe !== true && m.SenderJID === this.config.operator;
  }

  /** One pass: new operator messages after the cursor, oldest first; the cursor moves past each one handled. */
  async poll(): Promise<number> {
    const dir = this.dir();
    if (!dir || this.polling || !this.options.accepting()) return 0;
    this.polling = true;
    try {
      const cursor = this.cursor(dir);
      if (!cursor) { this.save(dir, { after: new Date(this.options.now()).toISOString(), seen: [] }); return 0; }
      const out = JSON.parse(await this.options.run(this.config.wacli, this.args('--read-only', 'messages', 'list', '--chat', this.config.chat, '--after', cursor.after, '--asc', '--limit', '20')));
      // wacli answers { success, data, error }; no store yet (not paired) or a lock problem comes back as an error.
      if (out?.success === false) throw new Error(`wacli: ${String(out.error).slice(0, 200)}`);
      const messages: Message[] = Array.isArray(out?.data?.messages) ? out.data.messages : [];
      let handled = 0;
      for (const m of messages) {
        if (cursor.seen.includes(m.MsgID)) continue;
        cursor.seen = [...cursor.seen, m.MsgID].slice(-50);
        if (Date.parse(m.Timestamp) > Date.parse(cursor.after)) cursor.after = m.Timestamp;
        if (this.fromOperator(m)) { await this.handle(m.Text!.trim()); handled++; }
        this.save(dir, cursor);
      }
      return handled;
    } finally { this.polling = false; }
  }

  private async handle(text: string): Promise<void> {
    const command = remoteCommand(text);
    if (!command) {
      const message = `${WHATSAPP_PREFIX}${text}`;
      this.pending.add(message);
      this.pi.sendUserMessage(message, { deliverAs: 'steer' });
      return;
    }
    const result = await command.command.run(this.state(), command.arg);
    await this.send(result.confirm ? `${result.text} Troca de conta só com aprovação no Slack (botão Aprovar) ou no terminal; pelo WhatsApp não troco.` : result.text);
  }

  /** Called for every user message of a run; a `[WhatsApp]` one makes this run answer in the chat. */
  sawUserMessage(text: string): void { if (this.pending.delete(text)) this.answering = true; }

  async runEnded(messages: readonly AgentMessage[]): Promise<void> {
    if (!this.answering) return;
    this.answering = false;
    try { await this.send(finalText(messages) || 'Recebi, mas a execução terminou sem resposta em texto.'); }
    catch (error) { this.options.warn(`WhatsApp reply not sent: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Only ever to the configured chat. A send is not retried: WhatsApp may already have the message. */
  async send(text: string): Promise<void> {
    const body = `${BOT_MARK}${text}`.slice(0, MAX_TEXT);
    await this.options.run(this.config.wacli, this.args('send', 'text', '--to', this.config.chat, '--message', body, ...(this.config.operator === 'self' ? ['--allow-self'] : [])));
  }

  private cursor(dir: string): { after: string; seen: string[] } | undefined {
    try {
      const c = JSON.parse(readFileSync(join(dir, CURSOR), 'utf8'));
      return typeof c.after === 'string' && Array.isArray(c.seen) ? c : undefined;
    } catch { return undefined; }
  }
  private save(dir: string, cursor: { after: string; seen: string[] }): void { atomicWrite(join(dir, CURSOR), JSON.stringify(cursor)); }
}

/** Wires the bridge into Pi when the config file exists; the Slack bridge's command state is shared. */
export function registerWhatsAppBridge(pi: ExtensionAPI, dir: () => string | undefined, state: () => CommandState, accepting: () => boolean): WhatsAppBridge | undefined {
  const config = readWhatsAppConfig();
  if (!config) return undefined;
  let warn: (text: string) => void = () => {};
  const bridge = new WhatsAppBridge(pi, config, dir, state, { warn: text => warn(text), accepting });
  pi.on('session_start', (_event, ctx) => { warn = text => ctx.ui.notify(text, 'warning'); bridge.start(); });
  pi.on('session_shutdown', () => bridge.stop());
  pi.on('message_end', ({ message }) => { const text = promptText(message); if (text !== undefined) bridge.sawUserMessage(text); });
  pi.on('agent_end', event => bridge.runEnded(event.messages));
  return bridge;
}
