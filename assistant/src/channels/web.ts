import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Event } from '../contracts/events.ts';
import type { Task, TaskStatus } from '../contracts/tasks.ts';
import { boundedText, oneOf, positive, text } from '../contracts/validation.ts';
import type { TaskStore } from '../store/db.ts';
import type { TaskPrompt } from '../runtime/task-executor.ts';
import type { StoredBriefings } from '../briefing/view.ts';
import { StoredPanel } from './stored-panel.ts';
import type { InspectionSource } from './inspection.ts';
import { capabilities, checkSetup, type SetupComponent } from '../setup.ts';
import type { ArtifactRegistry } from '../artifacts/registry.ts';
import { ArtifactRoutes } from '../artifacts/preview.ts';
import { authenticate } from '../http/auth.ts';
import { remoteOrigins } from './origins.ts';
import { unavailableVoice, voiceBodyLimit, type VoiceProvider } from '../voice.ts';
import { BadRequest, Conflict, mutation, numberParam, query, readBody, send, shape, taskIdParam } from '../http/io.ts';

/** Transitions a human may take from the panel; workers own working/needs_input/ready_for_review. */
export const operatorTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  suggested: ['queued', 'cancelled'],
  queued: ['cancelled'],
  working: ['cancelled'],
  needs_input: ['cancelled'],
  ready_for_review: ['succeeded', 'failed', 'cancelled'],
  succeeded: ['resolved'],
  failed: ['queued', 'resolved'],
  cancelled: ['resolved'],
  resolved: [],
};
const statuses = oneOf('suggested', 'queued', 'working', 'needs_input', 'ready_for_review', 'succeeded', 'failed', 'cancelled', 'resolved');
const requestId = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const channel = boundedText(80);
const cookieName = 'assistant_session';
const idleMs = 2 * 60 * 60 * 1000;
const absoluteMs = 12 * 60 * 60 * 1000;
const loginWindowMs = 60_000;
const loginFailures = 10;

const assets: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app/app.js': { file: 'src/app.js', type: 'text/javascript; charset=utf-8' },
  '/app/state.js': { file: 'src/state.js', type: 'text/javascript; charset=utf-8' },
  '/app/briefing.js': { file: 'src/briefing.js', type: 'text/javascript; charset=utf-8' },
  '/app/time.js': { file: 'src/time.js', type: 'text/javascript; charset=utf-8' },
  '/app/inspection.js': { file: 'src/inspection.js', type: 'text/javascript; charset=utf-8' },
  '/app/app.css': { file: 'src/app.css', type: 'text/css; charset=utf-8' },
  '/app/artifacts/artifacts.js': { file: 'src/artifacts/artifacts.js', type: 'text/javascript; charset=utf-8' },
  '/app/voice/voice.js': { file: 'src/voice/voice.js', type: 'text/javascript; charset=utf-8' },
  '/app/voice/media.js': { file: 'src/voice/media.js', type: 'text/javascript; charset=utf-8' },
  '/app/voice/voice-ui.js': { file: 'src/voice/voice-ui.js', type: 'text/javascript; charset=utf-8' },
};
const webRoot = new URL('../../web/', import.meta.url);
export const securityHeaders = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cache-control': 'no-store',
};

function serveAsset(res: ServerResponse, asset: { file: string; type: string }, voiceEnabled: boolean): void {
  const body = readFileSync(new URL(asset.file, webRoot));
  res.writeHead(200, { ...securityHeaders, ...(voiceEnabled ? { 'permissions-policy': 'camera=(), microphone=(self), geolocation=()' } : {}), 'content-type': asset.type });
  res.end(body);
}

type Session = { csrf: string; label: string; created: number; seen: number };
/** The draft executor's current question for a waiting task, shown in the panel with its quick answers. */
export type PromptSource = (task: Task) => TaskPrompt | null;
type Options = {
  store: TaskStore; token: string; profileId: string;
  artifacts?: ArtifactRegistry | undefined; voice?: VoiceProvider | undefined; now?: (() => number) | undefined;
  setup?: (() => SetupComponent[]) | undefined; origins?: readonly string[] | undefined;
  prompt?: PromptSource | undefined; briefings?: StoredBriefings | undefined; inspection?: InspectionSource | undefined;
};
const componentId = /^[a-z][a-z0-9-]{0,39}$/;

/** Browser access is authenticated, but is never trusted-local-human approval authority. */
export class WebChannel {
  private readonly sessions = new Map<string, Session>();
  private failures: number[] = [];
  private readonly store: TaskStore;
  private readonly token: string;
  private readonly profileId: string;
  private readonly now: () => number;
  private readonly setup: (() => SetupComponent[]) | undefined;
  private readonly artifacts: ArtifactRoutes | null;
  private readonly origins: Map<string, string>;
  private readonly voice: VoiceProvider | undefined;
  private readonly prompt: PromptSource | undefined;
  private readonly storedPanel: StoredPanel;
  constructor({ store, token, profileId, artifacts, voice, now = Date.now, setup, origins = [], prompt, briefings, inspection }: Options) {
    this.voice = voice; this.prompt = prompt; this.storedPanel = new StoredPanel(profileId, briefings, inspection);
    this.store = store; this.token = token; this.profileId = profileId; this.now = now; this.setup = setup;
    this.origins = remoteOrigins(origins);
    this.artifacts = artifacts ? new ArtifactRoutes(artifacts, now) : null;
  }
  owns(pathname: string): boolean { return Object.hasOwn(assets, pathname) || pathname === '/web' || pathname.startsWith('/web/') || pathname.startsWith('/app/'); }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Microphone permission is confined to this panel; it never changes effect approval authority.
    if (this.voice) res.setHeader('permissions-policy', 'camera=(), microphone=(self), geolocation=()');
    const host = this.allowedHost(req);
    if (!host) { send(res, 403, { error: 'Forbidden' }, securityHeaders); return; }
    if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) { query(url, []); serveAsset(res, assets[url.pathname], this.voice !== undefined); return; }
    if (!url.pathname.startsWith('/web/')) { send(res, 404, { error: 'Not found' }, securityHeaders); return; }
    if (req.method === 'POST' && !this.sameOrigin(req, host)) { send(res, 403, { error: 'Forbidden' }, securityHeaders); return; }
    if (url.pathname === '/web/session') { await this.session(req, res, url, host); return; }
    await this.authenticated(req, res, url, host);
  }

  private async authenticated(req: IncomingMessage, res: ServerResponse, url: URL, host: string): Promise<void> {
    const [id, session] = this.current(req);
    if (!session) { send(res, 401, { error: 'Unauthorized' }, securityHeaders); return; }
    if (req.method === 'POST' && req.headers['x-assistant-csrf'] !== session.csrf) { send(res, 403, { error: 'Forbidden' }, securityHeaders); return; }
    if (url.pathname === '/web/session/logout' && req.method === 'POST') {
      query(url, []); this.sessions.delete(id!);
      send(res, 200, { ok: true }, { ...securityHeaders, 'set-cookie': `${cookieName}=; ${this.cookieFlags(host)}Max-Age=0` }); return;
    }
    if (ArtifactRoutes.owns(url.pathname)) {
      if (!this.artifacts) { send(res, 503, { error: 'Artifacts not configured' }, securityHeaders); return; }
      await this.artifacts.handle(req, res, url, { sessionId: id!, origin: this.originOf(host), headers: securityHeaders, stillCurrent: () => this.stillCurrent(req, id!, session) }); return;
    }
    if (req.method === 'GET' && await this.storedPanel.handle(req, res, url, securityHeaders, () => this.stillCurrent(req, id!, session))) return;
    if (url.pathname.startsWith('/web/api/voice/')) { await this.voiceRoute(req, res, url, id!, session); return; }
    await this.api(req, res, url, id!, session);
  }

  private async voiceRoute(req: IncomingMessage, res: ServerResponse, url: URL, id: string, session: Session): Promise<void> {
    query(url, []);
    const headers = { ...securityHeaders, ...(this.voice ? { 'permissions-policy': 'camera=(), microphone=(self), geolocation=()' } : {}) };
    if (req.method === 'GET' && url.pathname === '/web/api/voice/status') { send(res, 200, this.voice?.status() ?? unavailableVoice, headers); return; }
    if (req.method !== 'POST' || url.pathname !== '/web/api/voice/transcribe') { send(res, 404, { error: 'Not found' }, headers); return; }
    if (!this.voice || this.voice.status().state !== 'available') { send(res, 503, { error: 'provider_unavailable' }, headers); return; }
    const input = await readBody(req, voiceBodyLimit);
    if (!this.stillCurrent(req, id, session)) { send(res, 401, { error: 'Unauthorized' }, headers); return; }
    const controller = new AbortController();
    const abortVoiceOnClose = () => controller.abort();
    res.once('close', abortVoiceOnClose);
    try {
      const result = await this.voice.transcribe(input, controller.signal);
      if (!this.stillCurrent(req, id, session)) { send(res, 401, { error: 'Unauthorized' }, headers); return; }
      send(res, 200, result, headers);
    } catch (error) {
      const code = error instanceof Error && /^voice_[a-z_]+$/.test(error.message) ? error.message : 'transcription_failed';
      send(res, code === 'voice_busy' ? 409 : 422, { error: code }, headers);
    } finally { res.off('close', abortVoiceOnClose); }
  }

  private allowedHost(req: IncomingMessage): string | null {
    const port = req.socket.localPort;
    const host = req.headers.host ?? '';
    // Web Locks and pending-write storage share only this canonical browser origin, plus configured HTTPS ones.
    return host === `127.0.0.1:${port}` || this.origins.has(host) ? host : null;
  }
  private originOf(host: string): string { return this.origins.get(host) ?? `http://${host}`; }
  private cookieFlags(host: string): string { return `HttpOnly; SameSite=Strict; ${this.origins.has(host) ? 'Secure; ' : ''}Path=/; `; }
  /** Revocation (logout, rotation, expiry) during a slow body read must stop the mutation. */
  private stillCurrent(req: IncomingMessage, sessionId: string, session: Session): boolean {
    const [currentId, currentSession] = this.current(req);
    return currentId === sessionId && currentSession === session;
  }
  private sameOrigin(req: IncomingMessage, host: string): boolean {
    const site = req.headers['sec-fetch-site'];
    return req.headers.origin === this.originOf(host) && (site === undefined || site === 'same-origin');
  }
  private current(req: IncomingMessage): [string | null, Session | null] {
    const id = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? null;
    const session = id ? this.sessions.get(id) ?? null : null;
    const now = this.now();
    if (!session || now - session.seen > idleMs || now - session.created > absoluteMs) { if (id) this.sessions.delete(id); return [null, null]; }
    session.seen = now;
    return [id, session];
  }
  private async session(req: IncomingMessage, res: ServerResponse, url: URL, host: string): Promise<void> {
    query(url, []);
    if (req.method === 'GET') {
      const [, session] = this.current(req);
      send(res, session ? 200 : 401, session ? { profileId: this.profileId, csrf: session.csrf } : { error: 'Unauthorized' }, securityHeaders); return;
    }
    if (req.method !== 'POST') { send(res, 404, { error: 'Not found' }, securityHeaders); return; }
    const now = this.now();
    this.failures = this.failures.filter(time => now - time < loginWindowMs);
    if (this.failures.length >= loginFailures) { send(res, 429, { error: 'Too many attempts' }, securityHeaders); return; }
    const body = await readBody(req);
    shape(body, { token: text });
    if (!authenticate(`Bearer ${(body as { token: string }).token}`, this.token)) { this.failures.push(now); send(res, 401, { error: 'Unauthorized' }, securityHeaders); return; }
    for (const [key, value] of this.sessions) {
      if (now - value.seen > idleMs || now - value.created > absoluteMs) this.sessions.delete(key);
    }
    const [oldId] = this.current(req);
    if (oldId) this.sessions.delete(oldId);
    if (this.sessions.size >= 32) { send(res, 429, { error: 'Session limit' }, securityHeaders); return; }
    const id = randomBytes(32).toString('base64url');
    const session: Session = { csrf: randomBytes(32).toString('base64url'), label: randomUUID(), created: now, seen: now };
    this.sessions.set(id, session);
    send(res, 200, { profileId: this.profileId, csrf: session.csrf }, { ...securityHeaders, 'set-cookie': `${cookieName}=${id}; ${this.cookieFlags(host)}Max-Age=${absoluteMs / 1000}` });
  }
  private async api(req: IncomingMessage, res: ServerResponse, url: URL, sessionId: string, session: Session): Promise<void> {
    const match = /^\/web\/api\/tasks\/([^/]+)\/(transition|respond)$/.exec(url.pathname);
    if (req.method === 'GET' && url.pathname === '/web/api/tasks') {
      query(url, ['cursor', 'limit']); const cursor = url.searchParams.get('cursor');
      if (cursor !== null && !text(cursor)) throw new BadRequest();
      const page = this.store.list(cursor, numberParam(url, 'limit', 100, 1, 100));
      // The subject of each listed task, so the panel does not depend on how much of the event stream it has paged.
      send(res, 200, { ...page, channels: this.store.creationChannels(page.tasks.map(task => task.taskId)) }, securityHeaders); return;
    }
    if (req.method === 'GET' && url.pathname === '/web/api/events') {
      query(url, ['after', 'limit']);
      send(res, 200, this.store.events(numberParam(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER), numberParam(url, 'limit', 100, 1, 100)), securityHeaders); return;
    }
    if (req.method === 'GET' && url.pathname === '/web/api/setup' && this.setup) { await this.setupStatus(res, url); return; }
    const asking = /^\/web\/api\/tasks\/([^/]+)\/prompt$/.exec(url.pathname);
    if (req.method === 'GET' && asking) { this.currentPrompt(res, url, taskIdParam(asking[1])); return; }
    if (req.method !== 'POST' || !(url.pathname === '/web/api/tasks' || match)) { send(res, 404, { error: 'Not found' }, securityHeaders); return; }
    query(url, []);
    const body = await readBody(req);
    const [currentId, currentSession] = this.current(req);
    if (currentId !== sessionId || currentSession !== session || req.headers['x-assistant-csrf'] !== session.csrf) {
      send(res, 401, { error: 'Unauthorized' }, securityHeaders); return;
    }
    if (url.pathname === '/web/api/tasks') {
      shape(body, { requestId, title: boundedText(200), channelId: channel });
      const input = body as { requestId: string; title: string; channelId: string };
      const task: Task = { version: 1, profileId: this.profileId, taskId: randomUUID(), title: input.title.trim(), status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: input.requestId };
      send(res, 200, mutation(() => this.store.create(task, this.event(task.taskId, input, session))), securityHeaders); return;
    }
    const id = taskIdParam(match![1]);
    if (match![2] === 'transition') {
      shape(body, { requestId, expectedRevision: positive, nextStatus: statuses, channelId: channel });
      const input = body as { requestId: string; expectedRevision: number; nextStatus: TaskStatus; channelId: string };
      const current = this.store.get(id);
      if (!current) { send(res, 404, { error: 'Not found' }, securityHeaders); return; }
      if (!operatorTransitions[current.status].includes(input.nextStatus)) {
        // A stale card is a conflict; a request the operator may never make is malformed.
        if (current.revision !== input.expectedRevision) { send(res, 409, { error: 'Conflict', task: current }, securityHeaders); return; }
        throw new BadRequest();
      }
      const result = this.conflictWithTask(res, id, () => this.store.transition(id, input.expectedRevision, input.nextStatus, this.event(id, input, session)));
      if (result) send(res, 200, result, securityHeaders);
      return;
    }
    shape(body, { requestId, revision: positive, inputRevision: positive, text: boundedText(4000), channelId: channel });
    const input = body as { requestId: string; revision: number; inputRevision: number; text: string; channelId: string };
    const response = { version: 1 as const, profileId: this.profileId, taskId: id, revision: input.revision, inputRevision: input.inputRevision, text: input.text };
    const result = this.conflictWithTask(res, id, () => this.store.respond(response, this.event(id, input, session)));
    if (result) send(res, 200, result, securityHeaders);
  }
  /** The question bound to the task's current revision and input request; a click answers only that one. */
  private currentPrompt(res: ServerResponse, url: URL, id: string): void {
    query(url, []);
    const task = this.store.get(id);
    if (!task) { send(res, 404, { error: 'Not found' }, securityHeaders); return; }
    send(res, 200, { taskId: task.taskId, revision: task.revision, inputRevision: task.inputRevision, prompt: this.prompt?.(task) ?? null }, securityHeaders);
  }
  /** Read-only: probes are local and unpaid; declining a source ("Agora não") only changes labels. */
  private async setupStatus(res: ServerResponse, url: URL): Promise<void> {
    query(url, ['declined']);
    const declined = (url.searchParams.get('declined') ?? '').split(',').filter(Boolean);
    if (declined.length > 20 || !declined.every(id => componentId.test(id))) throw new BadRequest();
    const components = this.setup!();
    const items = await checkSetup(components, { now: this.now });
    send(res, 200, { items, capabilities: capabilities(items, components, new Set(declined)) }, securityHeaders);
  }
  /** Stale decisions return the current card so the client replaces it rather than guessing. */
  private conflictWithTask(res: ServerResponse, id: string, operation: () => Task): Task | null {
    try { return mutation(operation); } catch (error) {
      if (error instanceof Conflict) { send(res, 409, { error: 'Conflict', task: this.store.get(id) }, securityHeaders); return null; }
      throw error;
    }
  }
  private event(taskId: string, input: { requestId: string; channelId: string }, session: Session): Event {
    return { version: 1, eventId: randomUUID(), correlationId: input.requestId, profileId: this.profileId, taskId, sessionId: session.label, channelId: input.channelId, runId: 'web-panel', source: { actorId: 'web-operator', sourceKind: 'external', sourceEventId: input.requestId }, observedAt: new Date(this.now()).toISOString(), sequence: this.store.nextSequence(), evidence: { kind: 'observed', reference: 'web-panel' } };
  }
}
