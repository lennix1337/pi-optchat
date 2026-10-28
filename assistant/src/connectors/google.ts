import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EffectMetadata, EffectRequest, Gateway } from '../policy/gateway.ts';
import { VaultError, type Vault } from '../secrets/vault.ts';
import type { WriteContext } from './mcp.ts';
import { boundedInteger } from '../limits.ts';
import { sha256 } from '../hash.ts';
import { local } from '../routines/schedule.ts';
import { immediate } from '../store/transaction.ts';

/**
 * Google mail and calendar, read-only. Each connection is an operator-named account (for example `personal` and
 * `dentai`) bound at consent to the identity Google verified; nothing picks a connection by default. Tokens live
 * only in the vault and are injected into one request at a time. Sending is a reviewed preview dispatched through
 * the gateway to a caller-supplied sink: this module requests no write scope and calls no Google mutation endpoint.
 */
const MAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const GOOGLE_READ_SCOPES: readonly string[] = ['openid', 'email', MAIL_SCOPE, CALENDAR_SCOPE];
/** Google reports `email` under its long name; anything outside this table is broader than consented and refused. */
const GRANTED_SCOPE_NAMES = new Map([['openid', 'openid'], ['email', 'email'], ['https://www.googleapis.com/auth/userinfo.email', 'email'], [MAIL_SCOPE, MAIL_SCOPE], [CALENDAR_SCOPE, CALENDAR_SCOPE]]);
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export type GoogleEndpoints = { authorization: string; token: string; revocation: string; api: string };
export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revocation: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com',
};
/** What a read may keep: how far back mail is read, how many items, how much body text, how many pages. */
export type GoogleRetention = { mailLookbackDays: number; maxMessages: number; maxBodyChars: number; maxEvents: number; maxPages: number };
const RETENTION: Record<keyof GoogleRetention, [fallback: number, min: number, max: number]> = {
  mailLookbackDays: [2, 1, 30], maxMessages: [50, 1, 500], maxBodyChars: [4000, 1, 20_000], maxEvents: [100, 1, 1000], maxPages: [10, 1, 50],
};
export type GoogleOptions = {
  databasePath: string; profileId: string; operatorAuthority: object; vault: Vault; gateway: Gateway;
  clientId: string; clientSecretRef?: string; redirectUri: string; endpoints?: GoogleEndpoints;
  fetch?: typeof fetch; now?: () => number; retention?: Partial<GoogleRetention>;
};
export type GoogleConnection = { connectionId: string; subject: string; email: string; scopes: string[]; state: 'active' | 'revoked' };
export type SourceRef = { connectionId: string; account: string; kind: 'gmail.message' | 'calendar.event'; id: string };
export type Attachment = { filename: string; mimeType: string; size: number; executable: boolean };
export type MailMessage = { ref: SourceRef; threadId: string; from: string; to: string; subject: string; receivedAt: string; labels: string[]; body: string; bodyTruncated: boolean; attachments: Attachment[] };
export type CalendarEvent = { ref: SourceRef; title: string; start: string; end: string; allDay: boolean; localDate: string; localStart: string | null; recurring: boolean; updated: string | null };
export type Page<T> = { items: T[]; truncated: boolean };
export type MessageDraft = { kind: 'message'; connectionId: string; to: string[]; subject: string; body: string };
export type EventDraft = { kind: 'event'; connectionId: string; calendarId: string; summary: string; start: string; end: string; attendees: string[] };
export type Draft = MessageDraft | EventDraft;
export type DraftPreview = { action: 'gmail.send' | 'calendar.insert'; account: string; destination: string; content: string; contentHash: string };
export type DraftSink<T> = (bytes: Uint8Array, metadata: Readonly<EffectMetadata>) => T | Promise<T>;

type Pending = { connectionId: string; expectedEmail: string; verifier: string; nonce: string; expires: number };
type Row = { connection_id: string; subject: string; email: string; scopes: string; access_ref: string; access_expires: number; refresh_ref: string; state: 'active' | 'revoked' };
type Tokens = { access_token: string; expires_in: number; refresh_token?: string; id_token?: string; scope?: string };
type Reply = { status: number; body: unknown };

const PENDING_MS = 10 * 60_000;
const MAX_PENDING = 32;
const REFRESH_MARGIN_MS = 60_000;
const DAY_MS = 86_400_000;
const CONNECTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EMAIL = /^[^\s@<>",;]{1,64}@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/;
const DATE = /^\d{4}-\d\d-\d\d$/;
/** Attachments are never downloaded; these are flagged so no consumer offers to open or run them. */
const EXECUTABLE_EXTENSIONS = new Set(['exe', 'com', 'scr', 'pif', 'msi', 'msp', 'msix', 'appx', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'wsf', 'wsh', 'hta', 'jar', 'lnk', 'url', 'reg', 'dll', 'cpl', 'iso', 'img', 'vhd', 'docm', 'xlsm', 'pptm', 'sh', 'app', 'apk', 'dmg', 'pkg']);
const EXECUTABLE_TYPES = new Set(['application/x-msdownload', 'application/x-msdos-program', 'application/x-msi', 'application/x-ms-installer', 'application/vnd.microsoft.portable-executable', 'application/x-executable', 'application/x-sh', 'application/java-archive', 'application/hta', 'application/x-bat']);

const fail = (code: string): never => { throw new Error(code); };
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= max;
const singleLine = (value: unknown, max: number): value is string => isText(value, max) && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const randomToken = () => randomBytes(32).toString('base64url');
const pad = (n: number) => String(n).padStart(2, '0');

function endpoint(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { return fail('invalid_options'); }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.hash) fail('invalid_options');
  return url.href;
}

/** RFC 8252: a loopback IP literal with an explicit port and nothing a browser could rewrite. */
function loopbackRedirect(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { return fail('invalid_options'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.href !== value) fail('invalid_options');
  return url.href;
}

function retention(input: Partial<GoogleRetention> = {}): GoogleRetention {
  return Object.fromEntries(Object.entries(RETENTION).map(([key, [fallback, min, max]]) => [key, boundedInteger(input[key as keyof GoogleRetention], fallback, min, max)])) as GoogleRetention;
}

export class GoogleConnections {
  private readonly db: DatabaseSync;
  private readonly options: GoogleOptions;
  private readonly endpoints: GoogleEndpoints;
  private readonly redirectUri: string;
  private readonly retention: GoogleRetention;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();

  constructor(options: GoogleOptions) {
    if (!options?.operatorAuthority || typeof options.operatorAuthority !== 'object' || !singleLine(options.profileId, 128) || !singleLine(options.clientId, 512) || !options.vault || !options.gateway) fail('invalid_options');
    if (options.clientSecretRef !== undefined && !singleLine(options.clientSecretRef, 64)) fail('invalid_options');
    this.redirectUri = loopbackRedirect(options.redirectUri);
    const endpoints = options.endpoints ?? GOOGLE_ENDPOINTS;
    this.endpoints = { authorization: endpoint(endpoints.authorization), token: endpoint(endpoints.token), revocation: endpoint(endpoints.revocation), api: endpoint(endpoints.api) };
    this.retention = retention(options.retention);
    this.options = { ...options };
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS google_connections (profile TEXT NOT NULL, connection_id TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL, scopes TEXT NOT NULL,
        access_ref TEXT NOT NULL, access_expires INTEGER NOT NULL, refresh_ref TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (profile, connection_id));`);
  }

  /** Starts consent for one named connection and the account the operator expects to see there. */
  begin(input: { connectionId: string; expectedEmail: string }, authority: object): { url: string; state: string } {
    this.authorize(authority);
    const connectionId = input?.connectionId, expectedEmail = input?.expectedEmail;
    if (typeof connectionId !== 'string' || !CONNECTION_ID.test(connectionId) || !singleLine(expectedEmail, 254) || !EMAIL.test(expectedEmail)) fail('invalid_connection');
    for (const [state, entry] of this.pending) if (entry.expires <= this.now() || this.pending.size >= MAX_PENDING) this.pending.delete(state);
    const state = randomToken(), verifier = randomToken(), nonce = randomToken();
    this.pending.set(state, { connectionId, expectedEmail: expectedEmail.toLowerCase(), verifier, nonce, expires: this.now() + PENDING_MS });
    const url = new URL(this.endpoints.authorization);
    url.search = new URLSearchParams({
      client_id: this.options.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: GOOGLE_READ_SCOPES.join(' '), state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', nonce,
      login_hint: expectedEmail, access_type: 'offline', prompt: 'consent',
    }).toString();
    return { url: url.href, state };
  }

  /** Finishes consent from the loopback callback URL: exact redirect, single-use state, PKCE exchange, verified identity. */
  async complete(callbackUrl: string, authority: object): Promise<GoogleConnection> {
    this.authorize(authority);
    let callback: URL;
    try { callback = new URL(callbackUrl); } catch { return fail('google_redirect_mismatch'); }
    if (`${callback.origin}${callback.pathname}` !== this.redirectUri || callback.username || callback.password) fail('google_redirect_mismatch');
    const state = callback.searchParams.get('state') ?? '';
    const pending = this.pending.get(state) ?? fail('google_state_invalid');
    this.pending.delete(state);
    if (pending.expires <= this.now()) fail('google_state_expired');
    const code = callback.searchParams.get('code');
    if (callback.searchParams.has('error') || !code) fail('google_consent_denied');
    const reply = await this.tokenRequest({ grant_type: 'authorization_code', code: code!, code_verifier: pending.verifier, client_id: this.options.clientId, redirect_uri: this.redirectUri });
    if (reply.status !== 200) fail('google_token_exchange_failed');
    const tokens = tokenResponse(reply.body, true);
    const identity = this.identity(tokens.id_token!, pending.nonce);
    // Tokens of a refused identity are only dropped: revoking at Google would end that account's whole grant to this client.
    if (identity.email !== pending.expectedEmail) fail('google_account_mismatch');
    return this.bind(pending.connectionId, identity, grantedScopes(tokens.scope!), tokens);
  }

  list(): GoogleConnection[] {
    return (this.db.prepare('SELECT * FROM google_connections WHERE profile = ? ORDER BY connection_id').all(this.options.profileId) as Row[]).map(connection);
  }

  /** Local revocation commits first, so access ends whatever Google answers; then Google is asked and the tokens erased. */
  async revoke(connectionId: string, authority: object): Promise<{ connectionId: string; remote: 'revoked' | 'not_confirmed' }> {
    this.authorize(authority);
    const row = this.active(connectionId);
    this.db.prepare("UPDATE google_connections SET state = 'revoked' WHERE profile = ? AND connection_id = ?").run(this.options.profileId, row.connection_id);
    let remote: 'revoked' | 'not_confirmed' = 'not_confirmed';
    try {
      const reply = await this.withSecret(row.refresh_ref, 'google.refresh', this.endpoints.token, token => this.request(this.endpoints.revocation, { method: 'POST', form: { token } }));
      if (reply.status === 200) remote = 'revoked';
    } catch (error) {
      // An unreachable Google or an unusable stored token leaves the remote grant unconfirmed, which is reported.
      if (!(error instanceof VaultError) && (error as Error).message !== 'google_unavailable') throw error;
    } finally {
      for (const ref of [row.access_ref, row.refresh_ref]) this.options.vault.revoke(ref, this.options.profileId);
    }
    return { connectionId: row.connection_id, remote };
  }

  /** Mail newer than the lookback window, newest pages first as Gmail returns them; bodies are plain text, bounded. */
  async listMessages(connectionId: string): Promise<Page<MailMessage>> {
    const row = this.active(connectionId);
    const after = this.now() - this.retention.mailLookbackDays * DAY_MS;
    const query = { q: `after:${Math.floor(after / 1000)}`, maxResults: String(Math.min(100, this.retention.maxMessages)) };
    return this.collect(connectionId, MAIL_SCOPE, '/gmail/v1/users/me/messages', query, 'messages', this.retention.maxMessages, async entry => {
      const id = (entry as { id?: unknown })?.id;
      if (!singleLine(id, 256)) return fail('google_response_invalid');
      const message = this.message(row, await this.get(connectionId, MAIL_SCOPE, `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, { format: 'full' }));
      return Date.parse(message.receivedAt) < after ? null : message;
    });
  }

  /** Single instances (recurring series expanded by Google) in [from, to), placed on the profile's local calendar. */
  async listEvents(connectionId: string, range: { from: string; to: string; timeZone: string }): Promise<Page<CalendarEvent>> {
    const from = Date.parse(range?.from), to = Date.parse(range?.to);
    if (!RFC3339.test(range?.from ?? '') || !RFC3339.test(range?.to ?? '') || !(from < to) || to - from > 62 * DAY_MS || !isTimeZone(range.timeZone)) fail('invalid_range');
    const row = this.active(connectionId);
    const query = { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', orderBy: 'startTime', timeZone: range.timeZone, maxResults: String(Math.min(250, this.retention.maxEvents)) };
    return this.collect(connectionId, CALENDAR_SCOPE, '/calendar/v3/calendars/primary/events', query, 'items', this.retention.maxEvents, async entry => calendarEvent(row, entry, range.timeZone));
  }

  /** The exact account, destination and content a send would carry. */
  preview(draft: Draft): DraftPreview {
    const content = draftContent(draft);
    const account = this.active(draft.connectionId).email;
    const json = JSON.stringify(content.body);
    return { action: content.action, account, destination: content.destination, content: json, contentHash: sha256(json) };
  }

  /** Asks the gateway for review; the review carries the bytes and metadata that dispatch will bind. */
  prepareSend(draft: Draft, write: WriteContext) {
    return this.options.gateway.prepare(this.effect(draft, write));
  }

  /** Dispatches only through the gateway, which admits it only under a grant for this account, destination and content. */
  send<T>(draft: Draft, write: WriteContext, sink: DraftSink<T>): Promise<T> {
    return this.options.gateway.dispatch(this.effect(draft, write), sink);
  }

  close(): void { this.db.close(); }

  private effect(draft: Draft, write: WriteContext): EffectRequest {
    const preview = this.preview(draft);
    return {
      version: 1, operationId: write?.operationId, profileId: this.options.profileId, sessionId: write?.sessionId, taskId: write?.taskId, runId: write?.runId,
      adapter: 'google', action: preview.action, account: preview.account, destination: preview.destination, policyVersion: write?.policyVersion,
      expiresAt: write?.expiresAt, payload: Buffer.from(preview.content),
    };
  }

  private authorize(authority: object): void { if (authority !== this.options.operatorAuthority) fail('unauthorized'); }

  private active(connectionId: unknown): Row {
    if (typeof connectionId !== 'string') return fail('google_connection_unknown');
    const row = this.db.prepare('SELECT * FROM google_connections WHERE profile = ? AND connection_id = ?').get(this.options.profileId, connectionId) as Row | undefined;
    if (!row) return fail('google_connection_unknown');
    if (row.state !== 'active') fail('google_connection_revoked');
    return row;
  }

  /** Signature is not checked: the token came straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7, step 6). */
  private identity(idToken: string, nonce: string): { subject: string; email: string } {
    let claims: Record<string, unknown>;
    try { claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { return fail('google_identity_invalid'); }
    const valid = claims && typeof claims === 'object' && ISSUERS.includes(claims.iss as string) && claims.aud === this.options.clientId
      && typeof claims.exp === 'number' && claims.exp * 1000 > this.now() && claims.nonce === nonce && claims.email_verified === true
      && typeof claims.sub === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(claims.sub) && singleLine(claims.email, 254) && EMAIL.test(claims.email);
    if (!valid) fail('google_identity_invalid');
    return { subject: claims.sub as string, email: (claims.email as string).toLowerCase() };
  }

  private bind(connectionId: string, identity: { subject: string; email: string }, scopes: string[], tokens: Tokens): GoogleConnection {
    const vault = this.options.vault, profileId = this.options.profileId;
    let replaced: Row | undefined;
    immediate(this.db, () => {
      const other = this.db.prepare("SELECT 1 FROM google_connections WHERE profile = ? AND subject = ? AND state = 'active' AND connection_id <> ?").get(profileId, identity.subject, connectionId);
      if (other) fail('google_account_already_connected');
      replaced = this.db.prepare('SELECT * FROM google_connections WHERE profile = ? AND connection_id = ?').get(profileId, connectionId) as Row | undefined;
      if (replaced?.state === 'active' && replaced.subject !== identity.subject) fail('google_account_mismatch');
      const accessRef = vault.put(Buffer.from(tokens.access_token), { profileId, origin: new URL(this.endpoints.api).origin, action: 'google.access' });
      const refreshRef = vault.put(Buffer.from(tokens.refresh_token!), { profileId, origin: new URL(this.endpoints.token).origin, action: 'google.refresh' });
      this.db.prepare(`INSERT INTO google_connections VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active') ON CONFLICT (profile, connection_id) DO UPDATE SET subject = excluded.subject,
        email = excluded.email, scopes = excluded.scopes, access_ref = excluded.access_ref, access_expires = excluded.access_expires, refresh_ref = excluded.refresh_ref, state = 'active'`)
        .run(profileId, connectionId, identity.subject, identity.email, JSON.stringify(scopes), accessRef, this.now() + tokens.expires_in * 1000, refreshRef);
    });
    if (replaced?.state === 'active') for (const ref of [replaced.access_ref, replaced.refresh_ref]) vault.revoke(ref, profileId);
    return { connectionId, subject: identity.subject, email: identity.email, scopes, state: 'active' };
  }

  private async refresh(row: Row): Promise<void> {
    const reply = await this.withSecret(row.refresh_ref, 'google.refresh', this.endpoints.token, token => this.tokenRequest({ grant_type: 'refresh_token', refresh_token: token, client_id: this.options.clientId }));
    if (reply.status === 400 || reply.status === 401) fail('google_reauthorization_required');
    if (reply.status !== 200) fail('google_request_failed');
    const tokens = tokenResponse(reply.body, false);
    this.options.vault.rotate(row.access_ref, { profileId: this.options.profileId, origin: new URL(this.endpoints.api).origin, action: 'google.access' }, Buffer.from(tokens.access_token));
    this.db.prepare("UPDATE google_connections SET access_expires = ? WHERE profile = ? AND connection_id = ? AND state = 'active'").run(this.now() + tokens.expires_in * 1000, this.options.profileId, row.connection_id);
  }

  /** One authenticated GET. The connection and its scope are rechecked on every request, so revocation stops a read mid-way. */
  private async get(connectionId: string, scope: string, path: string, query: Record<string, string>): Promise<unknown> {
    let row = this.active(connectionId);
    if (!(JSON.parse(row.scopes) as string[]).includes(scope)) fail('google_scope_missing');
    if (row.access_expires - REFRESH_MARGIN_MS <= this.now()) {
      await this.refresh(row);
      row = this.active(connectionId);
    }
    const url = new URL(path, this.endpoints.api);
    url.search = new URLSearchParams(query).toString();
    const reply = await this.withSecret(row.access_ref, 'google.access', this.endpoints.api, token => this.request(url.href, { method: 'GET', headers: { authorization: `Bearer ${token}` } }));
    if (reply.status === 401) fail('google_unauthorized');
    if (reply.status !== 200) fail('google_request_failed');
    return reply.body;
  }

  /** Follows nextPageToken until done, the item bound or the page bound; a repeated token is a loop, not more data. */
  private async collect<T>(connectionId: string, scope: string, path: string, query: Record<string, string>, key: string, max: number, take: (entry: unknown) => Promise<T | null>): Promise<Page<T>> {
    const items: T[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < this.retention.maxPages; page++) {
      const body = await this.get(connectionId, scope, path, pageToken === undefined ? query : { ...query, pageToken }) as Record<string, unknown>;
      const entries = body?.[key] ?? [];
      const next = body?.nextPageToken;
      if (!Array.isArray(entries) || (next !== undefined && !singleLine(next, 2048))) fail('google_response_invalid');
      for (const entry of entries as unknown[]) {
        if (items.length >= max) return { items, truncated: true };
        const item = await take(entry);
        if (item !== null) items.push(item);
      }
      if (next === undefined) return { items, truncated: false };
      if (items.length >= max) return { items, truncated: true };
      if (seen.has(next as string)) fail('google_pagination_loop');
      seen.add(next as string);
      pageToken = next as string;
    }
    return { items, truncated: true };
  }

  private message(row: Row, value: unknown): MailMessage {
    const m = value as { id?: unknown; threadId?: unknown; labelIds?: unknown; snippet?: unknown; internalDate?: unknown; payload?: GmailPart };
    if (!m || !singleLine(m.id, 256) || typeof m.internalDate !== 'string' || !/^\d{1,15}$/.test(m.internalDate) || !m.payload || typeof m.payload !== 'object') return fail('google_response_invalid');
    const headers = Array.isArray(m.payload.headers) ? m.payload.headers : [];
    const header = (name: string) => headers.find(h => typeof h?.name === 'string' && h.name.toLowerCase() === name)?.value;
    const text = plainText(m.payload, 0) ?? (typeof m.snippet === 'string' ? m.snippet : '');
    const chars = Array.from(text);
    return {
      ref: { connectionId: row.connection_id, account: row.email, kind: 'gmail.message', id: m.id },
      threadId: singleLine(m.threadId, 256) ? m.threadId : m.id,
      from: headerText(header('from')), to: headerText(header('to')), subject: headerText(header('subject')),
      receivedAt: new Date(Number(m.internalDate)).toISOString(),
      labels: Array.isArray(m.labelIds) ? m.labelIds.filter(label => singleLine(label, 128)) : [],
      body: chars.slice(0, this.retention.maxBodyChars).join(''), bodyTruncated: chars.length > this.retention.maxBodyChars,
      attachments: attachments(m.payload, 0),
    };
  }

  private async tokenRequest(form: Record<string, string>): Promise<Reply> {
    const ref = this.options.clientSecretRef;
    if (ref === undefined) return this.request(this.endpoints.token, { method: 'POST', form });
    return this.withSecret(ref, 'google.client', this.endpoints.token, secret => this.request(this.endpoints.token, { method: 'POST', form: { ...form, client_secret: secret } }));
  }

  /** Uses one vault secret for one request; errors raised inside are returned as themselves, not as the vault's wrapper. */
  private async withSecret<T>(ref: string, action: string, url: string, use: (secret: string) => Promise<T>): Promise<T> {
    let outcome: { value: T } | { error: unknown } | undefined;
    await this.options.vault.inject(ref, { profileId: this.options.profileId, origin: new URL(url).origin, action }, async secret => {
      try { outcome = { value: await use(secret.toString('utf8')) }; } catch (error) { outcome = { error }; }
    });
    if (!outcome || 'error' in outcome) throw outcome?.error ?? new Error('google_unavailable');
    return outcome.value;
  }

  private async request(url: string, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; form?: Record<string, string> }): Promise<Reply> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: init.method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json', ...init.headers, ...(init.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: init.form ? new URLSearchParams(init.form).toString() : undefined,
      });
    } catch { return fail('google_unavailable'); }
    let body: unknown = null;
    try { body = await response.json(); } catch (error) {
      // A non-JSON body leaves only the status to judge; a broken connection is unavailability.
      if (!(error instanceof SyntaxError)) fail('google_unavailable');
    }
    return { status: response.status, body };
  }
}

type GmailPart = { mimeType?: unknown; filename?: unknown; headers?: { name?: unknown; value?: unknown }[]; body?: { size?: unknown; data?: unknown }; parts?: GmailPart[] };

function headerText(value: unknown): string {
  return typeof value === 'string' && value.isWellFormed() ? value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 500) : '';
}

function plainText(part: GmailPart, depth: number): string | undefined {
  if (!part || depth > 10) return undefined;
  if (part.mimeType === 'text/plain' && !part.filename && typeof part.body?.data === 'string') return Buffer.from(part.body.data, 'base64url').toString('utf8').toWellFormed();
  for (const child of Array.isArray(part.parts) ? part.parts : []) {
    const text = plainText(child, depth + 1);
    if (text !== undefined) return text;
  }
  return undefined;
}

function attachments(part: GmailPart, depth: number): Attachment[] {
  if (!part || depth > 10) return [];
  const own: Attachment[] = [];
  if (typeof part.filename === 'string' && part.filename) {
    const filename = headerText(part.filename);
    const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : 'application/octet-stream';
    const extension = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() ?? '';
    const size = Number.isSafeInteger(part.body?.size) ? part.body!.size as number : 0;
    own.push({ filename, mimeType, size, executable: EXECUTABLE_EXTENSIONS.has(extension) || EXECUTABLE_TYPES.has(mimeType) || mimeType.includes('macroenabled') });
  }
  return [...own, ...(Array.isArray(part.parts) ? part.parts : []).flatMap(child => attachments(child, depth + 1))];
}

export function isTimeZone(timeZone: unknown): timeZone is string {
  if (!singleLine(timeZone, 64)) return false;
  try { local(0, timeZone); return true; } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** The local date and HH:MM of an instant in an IANA zone. */
export function localDateTime(instant: number, timeZone: string): { date: string; time: string } {
  const l = local(instant, timeZone);
  return { date: `${l.year}-${pad(l.month)}-${pad(l.day)}`, time: `${pad(l.hour)}:${pad(l.minute)}` };
}

function calendarEvent(row: Row, value: unknown, timeZone: string): CalendarEvent | null {
  const e = value as { id?: unknown; status?: unknown; summary?: unknown; start?: { dateTime?: unknown; date?: unknown }; end?: { dateTime?: unknown; date?: unknown }; recurringEventId?: unknown; updated?: unknown };
  if (!e || !singleLine(e.id, 1024)) return fail('google_response_invalid');
  if (e.status === 'cancelled') return null;
  const ref: SourceRef = { connectionId: row.connection_id, account: row.email, kind: 'calendar.event', id: e.id };
  const base = { ref, title: headerText(e.summary) || '(no title)', recurring: singleLine(e.recurringEventId, 1024), updated: typeof e.updated === 'string' && Number.isFinite(Date.parse(e.updated)) ? new Date(Date.parse(e.updated)).toISOString() : null };
  if (typeof e.start?.date === 'string' && DATE.test(e.start.date)) {
    // An all-day event is a calendar date, not an instant: it is never shifted by a time zone.
    return { ...base, allDay: true, start: e.start.date, end: typeof e.end?.date === 'string' && DATE.test(e.end.date) ? e.end.date : e.start.date, localDate: e.start.date, localStart: null };
  }
  const start = typeof e.start?.dateTime === 'string' && RFC3339.test(e.start.dateTime) ? Date.parse(e.start.dateTime) : NaN;
  const end = typeof e.end?.dateTime === 'string' && RFC3339.test(e.end.dateTime) ? Date.parse(e.end.dateTime) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return fail('google_response_invalid');
  const at = localDateTime(start, timeZone);
  return { ...base, allDay: false, start: new Date(start).toISOString(), end: new Date(end).toISOString(), localDate: at.date, localStart: at.time };
}

function tokenResponse(value: unknown, initial: boolean): Tokens {
  const t = value as Record<string, unknown>;
  const valid = t && typeof t === 'object' && isText(t.access_token, 4096) && t.token_type === 'Bearer' && Number.isSafeInteger(t.expires_in) && (t.expires_in as number) > 0 && (t.expires_in as number) <= 86_400
    && (!initial || (isText(t.refresh_token, 4096) && isText(t.id_token, 16_384) && typeof t.scope === 'string'));
  if (!valid) fail('google_token_invalid');
  return t as Tokens;
}

function grantedScopes(scope: string): string[] {
  const names = new Set<string>();
  for (const granted of scope.split(' ').filter(Boolean)) names.add(GRANTED_SCOPE_NAMES.get(granted) ?? fail('google_scope_mismatch'));
  if (!names.has('openid') || !names.has('email')) fail('google_scope_mismatch');
  return [...names].sort();
}

function connection(row: Row): GoogleConnection {
  return { connectionId: row.connection_id, subject: row.subject, email: row.email, scopes: JSON.parse(row.scopes), state: row.state };
}

function addresses(value: unknown, min: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > 50 || !value.every(a => singleLine(a, 254) && EMAIL.test(a))) return fail('invalid_draft');
  return [...new Set((value as string[]).map(a => a.toLowerCase()))].sort();
}

function instant(value: unknown): string {
  if (typeof value !== 'string' || !RFC3339.test(value) || !Number.isFinite(Date.parse(value))) return fail('invalid_draft');
  return new Date(Date.parse(value)).toISOString();
}

/** Each field is read once into an owned value with sorted keys, so the preview, review and dispatch see the same bytes. */
function draftContent(draft: Draft): { action: DraftPreview['action']; destination: string; body: Record<string, unknown> } {
  if (!draft || typeof draft !== 'object') return fail('invalid_draft');
  if (draft.kind === 'message') {
    const to = addresses(draft.to, 1), subject = draft.subject, body = draft.body;
    if (!singleLine(subject, 500) || typeof body !== 'string' || !body.isWellFormed() || body.length > 100_000) fail('invalid_draft');
    return { action: 'gmail.send', destination: to.join(','), body: { body, subject, to } };
  }
  if (draft.kind === 'event') {
    const calendarId = draft.calendarId, summary = draft.summary, attendees = addresses(draft.attendees, 0);
    const start = instant(draft.start), end = instant(draft.end);
    if (!singleLine(calendarId, 256) || !/^[A-Za-z0-9@._-]+$/.test(calendarId) || !singleLine(summary, 500) || Date.parse(end) <= Date.parse(start)) fail('invalid_draft');
    // Attendees receive invitations, so they are part of the destination the grant names.
    return { action: 'calendar.insert', destination: [`calendar:${calendarId}`, ...attendees].join(','), body: { attendees, calendarId, end, start, summary } };
  }
  return fail('invalid_draft');
}
