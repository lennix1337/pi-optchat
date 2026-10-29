import type { Received } from './inbound.ts';

/**
 * Slack Socket Mode: the assistant opens an outbound WebSocket with the app-level token, so Slack reaches a
 * loopback-only service without a public HTTPS endpoint. Envelopes arrive only on that authenticated connection;
 * the channel still checks workspace, app and sender. An envelope is acknowledged after it was admitted, so a
 * failure leaves Slack to redeliver it, and the delivery-derived task ID makes the redelivery a duplicate.
 */
export type SocketLike = {
  send(data: string): void; close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
};
export type SlackSocketOptions = {
  appToken: string;
  accept: (payload: unknown) => Received;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  connect?: (url: string) => SocketLike;
  /** Delay before reconnecting; grows to `maxDelayMs` and resets after a `hello`. */
  delayMs?: number; maxDelayMs?: number;
};

const OPEN_URL = 'https://slack.com/api/apps.connections.open';

export class SlackSocket {
  private readonly options: Required<Omit<SlackSocketOptions, 'log'>> & { log: (line: string) => void };
  private socket: SocketLike | null = null;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private delay: number;

  constructor(options: SlackSocketOptions) {
    if (!/^xapp-[\x21-\x7e]+$/.test(options.appToken)) throw new Error('invalid_app_token');
    this.options = {
      fetch: globalThis.fetch, connect: url => new WebSocket(url) as unknown as SocketLike, delayMs: 1000, maxDelayMs: 60_000,
      log: () => {}, ...options,
    };
    this.delay = this.options.delayMs;
  }

  start(): void { this.stopped = false; void this.open(); }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      const response = await this.options.fetch(OPEN_URL, { method: 'POST', headers: { authorization: `Bearer ${this.options.appToken}`, 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error' });
      const body = await response.json() as { ok?: boolean; url?: unknown; error?: unknown };
      if (!body.ok || typeof body.url !== 'string' || !body.url.startsWith('wss://')) {
        const error = typeof body.error === 'string' ? body.error.replace(/[^\w.-]/g, '').slice(0, 60) : `http_${response.status}`;
        this.options.log(`Slack Socket Mode connection refused: ${error}.`);
        // A revoked or wrong token does not fix itself by hammering the API.
        if (error === 'invalid_auth' || error === 'not_allowed_token_type' || error === 'token_revoked') { this.stopped = true; return; }
        return this.retry();
      }
      url = body.url;
    } catch {
      this.options.log('Slack Socket Mode connection failed: network.');
      return this.retry();
    }
    if (this.stopped) return;
    const socket = this.options.connect(url);
    this.socket = socket;
    socket.addEventListener('message', event => this.onMessage(socket, event.data));
    socket.addEventListener('close', () => { if (this.socket === socket) { this.socket = null; this.retry(); } });
    socket.addEventListener('error', () => { /* close follows */ });
  }

  private retry(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.open(), this.delay);
    this.timer.unref?.();
    this.delay = Math.min(this.delay * 2, this.options.maxDelayMs);
  }

  private onMessage(socket: SocketLike, data: unknown): void {
    let message: Record<string, any>;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message?.type === 'hello') { this.delay = this.options.delayMs; this.options.log('Slack Socket Mode connected.'); return; }
    if (message?.type === 'disconnect') {
      if (message.reason === 'link_disabled') { this.options.log('Slack Socket Mode disabled for this app.'); this.stop(); return; }
      socket.close();
      return;
    }
    if (typeof message?.envelope_id !== 'string') return;
    let result: Received;
    try { result = this.options.accept(message.payload); }
    catch {
      // Not acknowledged: Slack redelivers, and the delivery-derived task ID keeps it single.
      this.options.log('Slack event not admitted: internal error; left for redelivery.');
      return;
    }
    socket.send(JSON.stringify({ envelope_id: message.envelope_id }));
    this.options.log(`Slack event: ${result.outcome}.`);
  }
}
