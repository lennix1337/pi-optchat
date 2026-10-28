import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createGateway, type Gateway } from '../src/policy/gateway.ts';
import { Vault } from '../src/secrets/vault.ts';
import { GoogleConnections, type GoogleRetention } from '../src/connectors/google.ts';
import { TaskStore } from '../src/store/db.ts';
import { memoryProtector, privateDir } from './vault-support.ts';

/** Every token the fake issues starts with this, so a test can search any byte sink for a leaked token. */
export const TOKEN_CANARY = 'ya29.FAKE-CANARY';
export const CLIENT_ID = 'fixture-client.apps.googleusercontent.test';
export const CLIENT_SECRET = 'fixture-client-secret-canary';
export const ACCOUNTS = {
  personal: { sub: '104000000000000000001', email: 'lucas.home@example.test' },
  dentai: { sub: '207000000000000000002', email: 'lucas@dentai.example.test' },
} as const;
export type AccountKey = keyof typeof ACCOUNTS;
export const MAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

type Grant = { account: AccountKey; scopes: string[] };
type Code = Grant & { challenge: string; method: string; redirectUri: string; nonce: string; used: boolean };
type Attachment = { filename: string; mimeType: string; size: number };
export type FixtureMessage = { id: string; from: string; to?: string; subject: string; body: string; labels?: string[]; receivedAt: string; attachments?: Attachment[] };
export type FixtureEvent = Record<string, unknown> & { id: string; start: { dateTime?: string; date?: string; timeZone?: string } };
export type Logged = { method: string; path: string; account?: AccountKey; params: Record<string, string> };

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Resource shape Gmail returns for `messages.get?format=full`. Attachments carry only an attachmentId, never bytes. */
function gmailResource(m: FixtureMessage) {
  const headers = [{ name: 'From', value: m.from }, { name: 'To', value: m.to ?? 'me@example.test' }, { name: 'Subject', value: m.subject }];
  const parts: unknown[] = [{ partId: '0', mimeType: 'text/plain', filename: '', body: { size: m.body.length, data: b64url(m.body) } }];
  for (const [i, a] of (m.attachments ?? []).entries()) parts.push({ partId: String(i + 1), mimeType: a.mimeType, filename: a.filename, body: { size: a.size, attachmentId: `att-${m.id}-${i}` } });
  return { id: m.id, threadId: `thread-${m.id}`, labelIds: m.labels ?? ['INBOX'], snippet: m.body.slice(0, 40), internalDate: String(Date.parse(m.receivedAt)), payload: { mimeType: 'multipart/mixed', headers, parts } };
}

/**
 * A loopback stand-in for Google's OAuth, Gmail and Calendar endpoints. It enforces what the real service enforces
 * for this client (single-use code, exact redirect, S256 PKCE, client secret, bearer scopes, revocation) and
 * records every request, so tests can assert what reached "Google".
 */
export class FakeGoogle {
  origin = '';
  readonly log: Logged[] = [];
  readonly mail: Record<AccountKey, FixtureMessage[]> = { personal: [], dentai: [] };
  /** Instances as Google returns them with singleEvents=true; `masters` is what it returns otherwise. */
  readonly events: Record<AccountKey, FixtureEvent[]> = { personal: [], dentai: [] };
  readonly masters: Record<AccountKey, FixtureEvent[]> = { personal: [], dentai: [] };
  pageSize = 2;
  /** Overrides applied to the next id_token, to simulate a token for another audience or flow. */
  idTokenOverride: Record<string, unknown> = {};
  /** Scopes granted at consent instead of the requested ones (user unchecked a box, or a broader grant). */
  grantedScopes: string[] | null = null;
  failRevoke = false;
  /** Paths answered with this status instead of data. */
  readonly failures = new Map<string, number>();
  loopPageToken = false;
  readonly redirectUris = new Set<string>();
  private codes = new Map<string, Code>();
  private access = new Map<string, Grant & { expires: number }>();
  private refresh = new Map<string, Grant>();
  private server = createServer((req, res) => { void this.handle(req, res).catch(() => { res.statusCode = 500; res.end(); }); });
  private clock: { now: number };
  constructor(clock: { now: number }) { this.clock = clock; }

  async start(): Promise<void> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> { this.server.closeAllConnections(); this.server.close(); await once(this.server, 'close'); }
  get endpoints() { return { authorization: `${this.origin}/o/oauth2/v2/auth`, token: `${this.origin}/token`, revocation: `${this.origin}/revoke`, api: this.origin }; }
  requests(prefix: string): Logged[] { return this.log.filter(entry => entry.path.startsWith(prefix)); }

  /** The user's browser at the consent screen: validates the request like Google and returns the loopback callback URL. */
  consent(authorizationUrl: string, account: AccountKey): string {
    const url = new URL(authorizationUrl);
    const p = url.searchParams;
    if (`${url.origin}${url.pathname}` !== this.endpoints.authorization) throw new Error('fake: wrong authorization endpoint');
    if (p.get('client_id') !== CLIENT_ID || p.get('response_type') !== 'code' || !this.redirectUris.has(p.get('redirect_uri') ?? '')) throw new Error('fake: invalid_request');
    if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') ?? '')) throw new Error('fake: PKCE S256 required');
    const code = `code-${randomBytes(12).toString('hex')}`;
    const scopes = this.grantedScopes ?? (p.get('scope') ?? '').split(' ');
    this.codes.set(code, { account, scopes, challenge: p.get('code_challenge')!, method: 'S256', redirectUri: p.get('redirect_uri')!, nonce: p.get('nonce') ?? '', used: false });
    const back = new URL(p.get('redirect_uri')!);
    back.searchParams.set('state', p.get('state') ?? '');
    back.searchParams.set('code', code);
    back.searchParams.set('scope', scopes.join(' '));
    return back.href;
  }

  private issue(grant: Grant, withRefresh: boolean) {
    const accessToken = `${TOKEN_CANARY}-access-${randomBytes(9).toString('hex')}`;
    this.access.set(accessToken, { ...grant, expires: this.clock.now + 3600_000 });
    const result: Record<string, unknown> = { access_token: accessToken, expires_in: 3599, token_type: 'Bearer', scope: grant.scopes.join(' ') };
    if (withRefresh) {
      const refreshToken = `${TOKEN_CANARY}-refresh-${randomBytes(9).toString('hex')}`;
      this.refresh.set(refreshToken, grant);
      result.refresh_token = refreshToken;
    }
    return result;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const params = Object.fromEntries(req.method === 'POST' ? form : url.searchParams);
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const grant = bearer ? this.access.get(bearer) : undefined;
    this.log.push({ method: req.method ?? '', path: url.pathname, account: grant?.account, params });
    const failure = this.failures.get(url.pathname);
    if (failure) { send(failure, { error: 'fixture_failure' }); return; }

    if (req.method === 'POST' && url.pathname === '/token') {
      if (params.client_id !== CLIENT_ID || params.client_secret !== CLIENT_SECRET) { send(401, { error: 'invalid_client' }); return; }
      if (params.grant_type === 'authorization_code') {
        const code = this.codes.get(params.code ?? '');
        const verifier = params.code_verifier ?? '';
        if (!code || code.used || code.redirectUri !== params.redirect_uri || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(createHash('sha256').update(verifier).digest()) !== code.challenge) { send(400, { error: 'invalid_grant' }); return; }
        code.used = true;
        const who = ACCOUNTS[code.account];
        const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: who.sub, email: who.email, email_verified: true, nonce: code.nonce, iat: Math.floor(this.clock.now / 1000), exp: Math.floor(this.clock.now / 1000) + 3600, ...this.idTokenOverride };
        send(200, { ...this.issue(code, true), id_token: `${b64url(JSON.stringify({ alg: 'RS256', kid: 'fixture' }))}.${b64url(JSON.stringify(claims))}.fixture-signature` });
        return;
      }
      if (params.grant_type === 'refresh_token') {
        const known = this.refresh.get(params.refresh_token ?? '');
        if (!known) { send(400, { error: 'invalid_grant' }); return; }
        send(200, this.issue(known, false));
        return;
      }
      send(400, { error: 'unsupported_grant_type' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/revoke') {
      if (this.failRevoke) { send(503, { error: 'unavailable' }); return; }
      const token = params.token ?? '';
      const known = this.refresh.get(token) ?? this.access.get(token);
      if (!known) { send(400, { error: 'invalid_token' }); return; }
      // Revoking a refresh token also invalidates every access token of that grant, as Google does.
      for (const [key, value] of [...this.refresh, ...this.access]) if (value.account === known.account) { this.refresh.delete(key); this.access.delete(key); }
      send(200, {});
      return;
    }
    if (!grant || grant.expires <= this.clock.now) { send(401, { error: { code: 401, status: 'UNAUTHENTICATED' } }); return; }
    const page = <T>(items: T[]) => {
      const start = Number(params.pageToken ?? 0);
      const size = Math.min(this.pageSize, Number(params.maxResults ?? this.pageSize));
      const next = start + size < items.length ? String(start + size) : undefined;
      return { slice: items.slice(start, start + size), next: this.loopPageToken && next ? '0' : next };
    };
    if (url.pathname === '/gmail/v1/users/me/messages') {
      if (!grant.scopes.includes(MAIL_SCOPE)) { send(403, { error: 'insufficient_scope' }); return; }
      const { slice, next } = page(this.mail[grant.account]);
      send(200, { messages: slice.map(m => ({ id: m.id, threadId: `thread-${m.id}` })), ...(next ? { nextPageToken: next } : {}) });
      return;
    }
    const message = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
    if (message) {
      const found = this.mail[grant.account].find(m => m.id === decodeURIComponent(message[1]));
      if (!found || !grant.scopes.includes(MAIL_SCOPE)) { send(404, { error: 'not_found' }); return; }
      send(200, gmailResource(found));
      return;
    }
    if (url.pathname === '/calendar/v3/calendars/primary/events') {
      if (!grant.scopes.includes(CALENDAR_SCOPE)) { send(403, { error: 'insufficient_scope' }); return; }
      const min = Date.parse(params.timeMin ?? ''), max = Date.parse(params.timeMax ?? '');
      const source = params.singleEvents === 'true' ? this.events[grant.account] : this.masters[grant.account];
      const inRange = source.filter(e => { const at = Date.parse(e.start.dateTime ?? `${e.start.date}T00:00:00Z`); return at < max && at >= min - 86400_000; });
      const { slice, next } = page(inRange);
      send(200, { timeZone: params.timeZone, items: slice, ...(next ? { nextPageToken: next } : {}) });
      return;
    }
    send(404, { error: 'not_found' });
  }
}

export const hour = 3600_000;
export type GoogleRig = {
  dir: string; clock: { now: number }; authority: object; fake: FakeGoogle; vault: Vault; gateway: Gateway; google: GoogleConnections;
  store: TaskStore; redirectUri: string; databasePath: string; clientSecretRef: string;
  open: (overrides?: { retention?: Partial<GoogleRetention>; profileId?: string }) => GoogleConnections;
  connect: (connectionId: string, account: AccountKey, google?: GoogleConnections) => Promise<void>;
  /** Releases a resource the test opened (a database handle) before the directory is removed. */
  defer: (release: () => void) => void;
};

/** A disposable profile: owner-only directory, vault, gateway, task store, and the fake Google on loopback. */
export function withGoogle(fn: (rig: GoogleRig) => Promise<void>, start = Date.parse('2026-10-28T12:00:00.000Z')): Promise<void> {
  return privateDir('google-', async dir => {
    const clock = { now: start };
    const authority = {};
    const fake = new FakeGoogle(clock);
    await fake.start();
    const redirectUri = 'http://127.0.0.1:47613/oauth/google/callback';
    fake.redirectUris.add(redirectUri);
    const databasePath = join(dir, 'assistant.db');
    const vault = await Vault.open({ databasePath: join(dir, 'vault.db'), protector: memoryProtector().protector, now: () => clock.now });
    const gateway = createGateway({ databasePath, profileId: 'p', operatorAuthority: authority, now: () => clock.now, policy: metadata => metadata.adapter === 'google' ? 'review' : 'deny', inspect: () => ({ decision: 'allow', reasons: [] }) });
    const store = new TaskStore(join(dir, 'tasks.db'), 'p');
    const clientSecretRef = vault.put(Buffer.from(CLIENT_SECRET), { profileId: 'p', origin: fake.origin, action: 'google.client' });
    const releases: (() => void)[] = [];
    const defer = (release: () => void) => { releases.push(release); };
    const open = (overrides: { retention?: Partial<GoogleRetention>; profileId?: string } = {}) => {
      const google = new GoogleConnections({ databasePath, profileId: overrides.profileId ?? 'p', operatorAuthority: authority, vault, gateway, clientId: CLIENT_ID, clientSecretRef, redirectUri, endpoints: fake.endpoints, now: () => clock.now, retention: overrides.retention });
      defer(() => google.close());
      return google;
    };
    const google = open();
    const connect = async (connectionId: string, account: AccountKey, target = google) => {
      const { url } = target.begin({ connectionId, expectedEmail: ACCOUNTS[account].email }, authority);
      await target.complete(fake.consent(url, account), authority);
    };
    try {
      await fn({ dir, clock, authority, fake, vault, gateway, google, store, redirectUri, databasePath, clientSecretRef, open, connect, defer });
    } finally {
      for (const release of releases.reverse()) release();
      store.close();
      gateway.close();
      vault.close();
      await fake.close();
    }
  });
}

