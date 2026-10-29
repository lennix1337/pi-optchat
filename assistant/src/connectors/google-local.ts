import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { createGateway, type Gateway } from '../policy/gateway.ts';
import { Vault } from '../secrets/vault.ts';
import type { KeyProtector } from '../secrets/protector.ts';
import { TaskStore } from '../store/db.ts';
import { BriefingComposer, type Briefing } from '../briefing/compose.ts';
import { GOOGLE_ENDPOINTS, GoogleConnections, type GoogleConnection, type GoogleEndpoints } from './google.ts';
import type { Task } from '../contracts/tasks.ts';

/**
 * Operator-run Google connection for the local service's data directory. Read-only: the gateway here denies every
 * effect, so nothing is sent. The OAuth client secret lives in the vault; this file keeps only the client id and its
 * vault reference. Consent happens in the operator's own browser and returns to a one-shot loopback listener.
 */
export type GoogleLocalOptions = {
  databasePath: string; profileId: string; protector: KeyProtector;
  endpoints?: GoogleEndpoints; fetch?: typeof fetch; now?: () => number;
};
type ClientFile = { version: 1; clientId: string; clientSecretRef: string };
const CALLBACK_PATH = '/';
const fail = (code: string): never => { throw new Error(code); };

const clientPath = (databasePath: string) => join(dirname(databasePath), 'google-client.json');

/** Reads Google's downloaded "Desktop app" client JSON; only an installed-app client is accepted. */
export function parseClientJson(text: string): { clientId: string; clientSecret: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail('google_client_invalid'); }
  const installed = (parsed as { installed?: { client_id?: unknown; client_secret?: unknown } })?.installed;
  const clientId = installed?.client_id, clientSecret = installed?.client_secret;
  if (typeof clientId !== 'string' || !/^[\w.-]{1,200}\.apps\.googleusercontent\.com$/.test(clientId) || typeof clientSecret !== 'string' || !/^[\w-]{1,200}$/.test(clientSecret)) fail('google_client_invalid');
  return { clientId: clientId as string, clientSecret: clientSecret as string };
}

export class GoogleLocal {
  private readonly authority = {};
  private readonly options: GoogleLocalOptions;
  private readonly vault: Vault;
  private readonly gateway: Gateway;
  private constructor(options: GoogleLocalOptions, vault: Vault, gateway: Gateway) { this.options = options; this.vault = vault; this.gateway = gateway; }

  static async open(options: GoogleLocalOptions): Promise<GoogleLocal> {
    const dir = dirname(options.databasePath);
    const vault = await Vault.open({ databasePath: join(dir, 'vault.sqlite'), protector: options.protector, ...(options.now ? { now: options.now } : {}) });
    const gateway = createGateway({
      databasePath: join(dir, 'google-gateway.sqlite'), profileId: options.profileId, operatorAuthority: {},
      policy: () => 'deny', inspect: () => ({ decision: 'deny', reasons: ['read_only_connection'] }), ...(options.now ? { now: options.now } : {}),
    });
    return new GoogleLocal(options, vault, gateway);
  }

  private get endpoints(): GoogleEndpoints { return this.options.endpoints ?? GOOGLE_ENDPOINTS; }

  /** Stores the client secret in the vault and the client id beside the data. Replacing a client revokes the old secret. */
  setClient(json: string): { clientId: string } {
    const { clientId, clientSecret } = parseClientJson(json);
    const previous = this.client();
    const clientSecretRef = this.vault.put(Buffer.from(clientSecret), { profileId: this.options.profileId, origin: new URL(this.endpoints.token).origin, action: 'google.client' });
    const file: ClientFile = { version: 1, clientId, clientSecretRef };
    writeFileSync(clientPath(this.options.databasePath), `${JSON.stringify(file)}\n`, { mode: 0o600 });
    if (previous) this.vault.revoke(previous.clientSecretRef, this.options.profileId);
    return { clientId };
  }

  private client(): ClientFile | null {
    const path = clientPath(this.options.databasePath);
    if (!existsSync(path)) return null;
    const file = JSON.parse(readFileSync(path, 'utf8')) as ClientFile;
    if (file?.version !== 1 || typeof file.clientId !== 'string' || typeof file.clientSecretRef !== 'string') fail('google_client_invalid');
    return file;
  }

  private connections(redirectUri = 'http://127.0.0.1:1/'): GoogleConnections {
    const client = this.client() ?? fail('google_client_missing');
    return new GoogleConnections({
      databasePath: join(dirname(this.options.databasePath), 'google.sqlite'), profileId: this.options.profileId, operatorAuthority: this.authority,
      vault: this.vault, gateway: this.gateway, clientId: client.clientId, clientSecretRef: client.clientSecretRef, redirectUri, endpoints: this.endpoints,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}), ...(this.options.now ? { now: this.options.now } : {}),
    });
  }

  /**
   * Opens a one-shot listener on a free loopback port, hands the consent URL to `onUrl` and finishes when the browser
   * returns. Only the exact callback path with the pending state is completed; anything else gets 404.
   */
  async connect(input: { name: string; email: string; onUrl: (url: string) => void; timeoutMs?: number }): Promise<GoogleConnection> {
    // Checked before listening, so a missing client never leaves a port open.
    if (!this.client()) fail('google_client_missing');
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${CALLBACK_PATH}`;
    let google: GoogleConnections | undefined;
    try {
      const connections = google = this.connections(redirectUri);
      const { url, state } = connections.begin({ connectionId: input.name, expectedEmail: input.email }, this.authority);
      const done = new Promise<GoogleConnection>((resolve, reject) => {
        server.on('request', (req, res) => {
          const callback = new URL(req.url ?? '/', redirectUri);
          if (req.method !== 'GET' || callback.pathname !== CALLBACK_PATH || callback.searchParams.get('state') !== state) { res.writeHead(404).end(); return; }
          connections.complete(callback.href, this.authority).then(connection => {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Conta conectada ao assistente. Pode fechar esta aba.');
            resolve(connection);
          }, error => {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`Conexão recusada: ${(error as Error).message}`);
            reject(error);
          });
        });
      });
      input.onUrl(url);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('google_consent_timeout')), input.timeoutMs ?? 300_000); });
      try { return await Promise.race([done, timeout]); } finally { clearTimeout(timer); }
    } finally {
      google?.close();
      server.closeAllConnections();
      server.close();
    }
  }

  list(): GoogleConnection[] {
    if (!this.client()) return [];
    const google = this.connections();
    try { return google.list(); } finally { google.close(); }
  }

  async revoke(name: string): Promise<{ connectionId: string; remote: 'revoked' | 'not_confirmed' }> {
    const google = this.connections();
    try { return await google.revoke(name, this.authority); } finally { google.close(); }
  }

  /** Reads the named connections now and stores the briefing; mail stays untrusted and nothing is started. */
  async briefing(names: string[], timeZone: string): Promise<Briefing> {
    return this.withComposer(names, timeZone, composer => composer.onDemand());
  }

  /** Turns one briefing item into a queued local task; repeating it returns the same task. */
  async start(briefingId: string, itemId: string, names: string[], timeZone: string): Promise<Task> {
    return this.withComposer(names, timeZone, async composer => composer.start(briefingId, itemId, this.authority, {
      requestId: randomUUID(), sessionId: 'google-cli', channelId: 'local-cli', actorId: 'operator', sourceKind: 'trusted-local-human',
    }));
  }

  /** Runs `use` with a composer over the named connections and the service's task store, closing both after. */
  async withComposer<T>(names: string[], timeZone: string, use: (composer: BriefingComposer) => T | Promise<T>): Promise<T> {
    const google = this.connections();
    const store = new TaskStore(this.options.databasePath, this.options.profileId);
    try {
      const composer = new BriefingComposer({
        databasePath: join(dirname(this.options.databasePath), 'briefings.sqlite'), profileId: this.options.profileId, operatorAuthority: this.authority,
        timeZone, store, google, connections: names, rules: { trustedSenders: [] }, ...(this.options.now ? { now: this.options.now } : {}),
      });
      try { return await use(composer); } finally { composer.close(); }
    } finally { store.close(); google.close(); }
  }

  close(): void { this.gateway.close(); this.vault.close(); }
}
