import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseTask, type TaskResponse, type TaskStatus } from '../contracts/tasks.ts';
import { boundedText, oneOf, optionalFields, positive, text, version } from '../contracts/validation.ts';
import type { SlackPoster, SlackRelay } from '../channels/slack-relay.ts';
import type { Event } from '../contracts/events.ts';
import { TaskStore } from '../store/db.ts';
import type { ArtifactRegistry } from '../artifacts/registry.ts';
import type { VoiceProvider } from '../voice.ts';
import type { ExecutorStatus } from '../runtime/task-executor.ts';
import { securityHeaders, WebChannel, type PromptSource } from '../channels/web.ts';
import type { SetupComponent } from '../setup.ts';
import type { InspectionSource } from '../channels/inspection.ts';
import { authenticate } from './auth.ts';
import { BadRequest, Conflict, mutation, numberParam, query, readBody, send, shape, taskIdParam } from './io.ts';

type Diagnostic = { category: 'internal'; operation: 'request' };
type ErrorObserver = (diagnostic: Diagnostic) => void | Promise<void>;
function safeLog(message: string): void {
  try { console.error(message); } catch { /* Diagnostics must not disrupt the request. */ }
}
export function reportError(observer: ErrorObserver): void {
  try {
    Promise.resolve(observer({ category: 'internal', operation: 'request' })).catch(() => safeLog('assistant HTTP diagnostic observer failed'));
  } catch { safeLog('assistant HTTP diagnostic observer failed'); }
}
const statuses = oneOf('suggested', 'queued', 'working', 'needs_input', 'ready_for_review', 'succeeded', 'failed', 'cancelled', 'resolved');
type Context = { sessionId: string; channelId: string; runId: string; sourceEventId: string; evidenceReference: string };

function event(store: TaskStore, profileId: string, taskId: string, context: Context): Event {
  return { version: 1, eventId: randomUUID(), correlationId: randomUUID(), profileId, taskId, sessionId: context.sessionId, channelId: context.channelId, runId: context.runId, source: { actorId: 'assistant-client', sourceKind: 'model', sourceEventId: context.sourceEventId }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), evidence: { kind: 'observed', reference: context.evidenceReference } };
}
const contextSchema = { sessionId: text, channelId: text, runId: text, sourceEventId: text, evidenceReference: text };
const responseSchema = { version, profileId: text, taskId: text, revision: positive, inputRevision: positive, text };

export function isAllowedRemote(address: string | undefined): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '');
}
/** The Google briefing as the service keeps it; absent when the server config names no Google connection. */
export type BriefingProvider = { latest(): Promise<unknown | null>; refresh(): Promise<unknown> };
/** The operator's Slack DM and project channels (name -> id) as a chat: queued operator messages, posting back to them only. */
export type SlackBridge = { relay: SlackRelay; poster?: SlackPoster; channels?: Record<string, string>; /** Where attachments the operator sent are saved. */ filesDir?: string };
/** The deterministic signal/outcome journal when `"signals":true`; every method validates its own input. */
export type JournalApi = {
  ingest(value: unknown): unknown;
  signals(after: number, limit: number): unknown;
  metrics(from: number, to: number): unknown;
  recordOutcome(value: unknown): unknown;
  outcomes(after: number, limit: number): unknown;
  review(now?: number): unknown;
  latestReview(): unknown;
  digest(day?: string): unknown;
};
const threadTs = (value: unknown) => value === null || typeof value === 'string' && /^\d{1,12}\.\d{1,8}$/.test(value);

async function slackRoute(req: IncomingMessage, res: ServerResponse, url: URL, slack: SlackBridge): Promise<void> {
  if (req.method === 'GET' && url.pathname === '/v1/slack/inbox') {
    query(url, ['after', 'limit']);
    const names = new Map(Object.entries(slack.channels ?? {}).map(([name, id]) => [id, name]));
    const messages = slack.relay.after(numberParam(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER), numberParam(url, 'limit', 20, 1, 100));
    send(res, 200, { messages: messages.map(m => ({ ...m, channelName: names.get(m.channel) ?? null })) }); return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/slack/send') {
    query(url, []);
    const body = await readBody(req);
    // `channel` names a configured project channel; without it the message goes to the operator's DM.
    const known = (value: unknown) => typeof value === 'string' && Object.hasOwn(slack.channels ?? {}, value);
    shape(body, { text: boundedText(40_000), threadTs, ...optionalFields(body, { channel: known, approval: (v: unknown) => typeof v === 'boolean', broadcast: (v: unknown) => typeof v === 'boolean' }) });
    if (!slack.poster) { send(res, 503, { error: 'Slack bot token not configured' }); return; }
    const input = body as { text: string; threadTs: string | null; channel?: string; approval?: boolean; broadcast?: boolean };
    try { send(res, 200, await slack.poster.send(input.text, input.threadTs ?? undefined, input.channel, { approval: input.approval === true, ...(input.broadcast === true ? { broadcast: true } : {}) })); }
    catch (error) { send(res, 502, { error: error instanceof Error && /^[a-z][\w.-]{0,80}$/.test(error.message) ? error.message : 'slack_failed' }); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/slack/update') {
    query(url, []);
    const body = await readBody(req);
    // Rewrites one of the bot's own DM posts (an approval once decided); Slack refuses edits to anyone else's message.
    shape(body, { channel: (v: unknown) => typeof v === 'string' && /^D[A-Z0-9]{2,20}$/.test(v), ts: (v: unknown) => typeof v === 'string' && threadTs(v), text: boundedText(4_000) });
    if (!slack.poster) { send(res, 503, { error: 'Slack bot token not configured' }); return; }
    const input = body as { channel: string; ts: string; text: string };
    try { await slack.poster.update(input.channel, input.ts, input.text); send(res, 200, { ok: true }); }
    catch (error) { send(res, 502, { error: error instanceof Error && /^[a-z][\w.-]{0,80}$/.test(error.message) ? error.message : 'slack_failed' }); }
    return;
  }
  const extra = SLACK_EXTRA[url.pathname];
  if (req.method === 'POST' && extra) {
    query(url, []);
    const body = await readBody(req);
    shape(body, extra.shape);
    if (!slack.poster) { send(res, 503, { error: 'Slack bot token not configured' }); return; }
    try { send(res, 200, (await extra.run(slack.poster, body as Record<string, any>, slack)) ?? { ok: true }); }
    catch (error) { send(res, 502, { error: error instanceof Error && /^[a-z][\w.-]{0,80}$/.test(error.message) ? error.message : 'slack_failed' }); }
    return;
  }
  send(res, 404, { error: 'Not found' });
}

const channelId = (v: unknown) => typeof v === 'string' && /^[CDG][A-Z0-9]{2,20}$/.test(v);
const messageTs = (v: unknown) => typeof v === 'string' && threadTs(v);
/** Reactions on the operator's messages, reading a message he linked, his App Home, and saving a file he sent. */
const SLACK_EXTRA: Record<string, { shape: Record<string, (v: unknown) => boolean>; run: (poster: SlackPoster, body: Record<string, any>, slack: SlackBridge) => Promise<unknown> }> = {
  '/v1/slack/react': { shape: { channel: channelId, ts: messageTs, name: (v: unknown) => typeof v === 'string' && /^[a-z0-9_+-]{1,40}$/.test(v), remove: (v: unknown) => typeof v === 'boolean' }, run: (p, b) => p.react(b.channel, b.ts, b.name, b.remove) },
  '/v1/slack/fetch': { shape: { channel: channelId, ts: messageTs, thread: messageTs }, run: (p, b) => p.fetchMessage(b.channel, b.ts, b.thread) },
  '/v1/slack/home': { shape: { text: boundedText(3_000) }, run: (p, b) => p.publishHome(b.text) },
  '/v1/slack/download': {
    shape: { url: (v: unknown) => typeof v === 'string' && v.length < 2000, name: boundedText(200) },
    run: (p, b, slack) => { if (!slack.filesDir) throw new Error('no_files_dir'); return p.download(b.url, b.name, slack.filesDir); },
  },
};

type OptionalRoutes = { briefings?: BriefingProvider | undefined; slack?: SlackBridge | undefined; executor?: (() => ExecutorStatus) | undefined; journal?: JournalApi | undefined };
async function handle(req: IncomingMessage, res: ServerResponse, store: TaskStore, token: string, profileId: string, onError: ErrorObserver, web: WebChannel | null, { briefings, slack, executor, journal }: OptionalRoutes): Promise<void> {
  try {
    if (!isAllowedRemote(req.socket.remoteAddress)) { send(res, 403, { error: 'Forbidden' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (web?.owns(url.pathname)) {
      for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
      await web.handle(req, res, url); return;
    }
    if (req.headers.origin !== undefined) { send(res, 403, { error: 'Forbidden' }); return; }
    if (!authenticate(req.headers.authorization, token)) { send(res, 401, { error: 'Unauthorized' }); return; }
    if (url.pathname === '/v1/briefing' && briefings && (req.method === 'GET' || req.method === 'POST')) {
      query(url, []);
      if (req.method === 'POST') { shape(await readBody(req), {}); send(res, 200, await briefings.refresh()); return; }
      const latest = await briefings.latest();
      send(res, latest ? 200 : 404, latest ?? { error: 'Not found' }); return;
    }
    if (url.pathname.startsWith('/v1/slack/') && slack) { await slackRoute(req, res, url, slack); return; }
    if (req.method === 'GET' && url.pathname === '/v1/executor' && executor) { query(url, []); send(res, 200, executor()); return; }
    if (journal && url.pathname === '/v1/signals' && (req.method === 'GET' || req.method === 'POST')) {
      query(url, req.method === 'GET' ? ['after', 'limit'] : []);
      if (req.method === 'GET') { send(res, 200, journal.signals(numberParam(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER), numberParam(url, 'limit', 50, 1, 100))); return; }
      try { send(res, 200, journal.ingest(await readBody(req))); } catch (error) { if (error instanceof TypeError) throw new BadRequest(); throw error; }
      return;
    }
    if (journal && req.method === 'GET' && url.pathname === '/v1/signals/metrics') {
      query(url, ['from', 'to']);
      send(res, 200, journal.metrics(numberParam(url, 'from', 0, 0, Number.MAX_SAFE_INTEGER), numberParam(url, 'to', Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER)));
      return;
    }
    if (journal && url.pathname === '/v1/outcomes' && (req.method === 'GET' || req.method === 'POST')) {
      query(url, req.method === 'GET' ? ['after', 'limit'] : []);
      if (req.method === 'GET') { send(res, 200, journal.outcomes(numberParam(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER), numberParam(url, 'limit', 50, 1, 100))); return; }
      try { send(res, 200, journal.recordOutcome(await readBody(req))); } catch (error) { if (error instanceof TypeError) throw new BadRequest(); throw error; }
      return;
    }
    if (journal && url.pathname === '/v1/review' && (req.method === 'GET' || req.method === 'POST')) {
      query(url, []);
      if (req.method === 'POST') { shape(await readBody(req), {}); send(res, 200, journal.review()); return; }
      const review = journal.latestReview();
      send(res, review ? 200 : 404, review ?? { error: 'Not found' }); return;
    }
    if (journal && req.method === 'GET' && url.pathname === '/v1/journal/digest') {
      query(url, ['day']);
      const day = url.searchParams.get('day') ?? undefined;
      if (day !== undefined && !/^\d{4}-\d\d-\d\d$/.test(day)) throw new BadRequest();
      try { send(res, 200, journal.digest(day)); } catch (error) { if (error instanceof TypeError) throw new BadRequest(); throw error; }
      return;
    }
    const match = /^\/v1\/tasks\/([^/]+)(?:\/(transition|respond))?$/.exec(url.pathname);
    const id = match ? taskIdParam(match[1]) : undefined;
    if (req.method === 'GET' && url.pathname === '/v1/tasks') {
      query(url, ['cursor', 'limit']); const cursor = url.searchParams.get('cursor');
      if (cursor !== null && !text(cursor)) throw new BadRequest();
      send(res, 200, store.list(cursor, numberParam(url, 'limit', 50, 1, 100))); return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      query(url, ['after', 'limit']); send(res, 200, store.events(numberParam(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER), numberParam(url, 'limit', 50, 1, 100))); return;
    }
    if (req.method === 'GET' && match && !match[2]) {
      query(url, []); const task = store.get(id!); send(res, task ? 200 : 404, task ?? { error: 'Not found' }); return;
    }
    if (req.method !== 'POST' || !(url.pathname === '/v1/tasks' || (match && match[2]))) { send(res, 404, { error: 'Not found' }); return; }
    query(url, []);
    const body = await readBody(req);
    if (url.pathname === '/v1/tasks') {
      shape(body, { task: value => { try { parseTask(value); return true; } catch (error) { if (error instanceof TypeError) return false; throw error; } }, context: contextSchema });
      const input = body as { task: ReturnType<typeof parseTask>; context: Context };
      if (input.task.profileId !== profileId || input.task.sourceEventId !== input.context.sourceEventId) throw new BadRequest();
      const entry = event(store, profileId, input.task.taskId, input.context);
      send(res, 200, mutation(() => store.create(input.task, entry))); return;
    }
    if (match![2] === 'transition') {
      shape(body, { expectedRevision: positive, nextStatus: statuses, context: contextSchema });
      const input = body as { expectedRevision: number; nextStatus: TaskStatus; context: Context };
      const entry = event(store, profileId, id!, input.context);
      send(res, 200, mutation(() => store.transition(id!, input.expectedRevision, input.nextStatus, entry))); return;
    }
    shape(body, { response: responseSchema, context: contextSchema });
    const input = body as { response: TaskResponse; context: Context };
    if (input.response.profileId !== profileId || input.response.taskId !== id) throw new BadRequest();
    const entry = event(store, profileId, id!, input.context);
    send(res, 200, mutation(() => store.respond(input.response, entry)));
  } catch (error) {
    if (error instanceof BadRequest) send(res, 400, { error: 'Bad request' });
    else if (error instanceof Conflict) send(res, 409, { error: 'Conflict' });
    else { reportError(onError); send(res, 500, { error: 'Internal error' }); }
  }
}
/** Optional surfaces are fields here, so adding one does not change the server's signature. */
export type AssistantServerOptions = OptionalRoutes & {
  store: TaskStore; token: string; profileId: string; web?: boolean; webOrigins?: readonly string[];
  setup?: () => SetupComponent[]; artifacts?: ArtifactRegistry; voice?: VoiceProvider; prompt?: PromptSource; inspection?: InspectionSource; journal?: JournalApi; onError?: ErrorObserver;
};

export function createAssistantServer({ store, token, profileId, web = false, webOrigins, setup, artifacts, voice, prompt, inspection, journal, briefings, slack, executor, onError = () => safeLog('assistant HTTP internal request failure') }: AssistantServerOptions): Server {
  if (!text(token) || !text(profileId) || !store.matchesProfile(profileId) || (artifacts && !artifacts.matchesProfile(profileId))) throw new TypeError('Invalid server binding');
  const channel = web ? new WebChannel({ store, token, profileId, setup, origins: webOrigins, artifacts, voice, prompt, briefings, inspection }) : null;
  const server = createServer((req, res) => { void handle(req, res, store, token, profileId, onError, channel, { briefings, slack, executor, journal }).catch(() => { reportError(onError); res.destroy(); }); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  return server;
}
