import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseTask, type TaskResponse, type TaskStatus } from '../contracts/tasks.ts';
import { oneOf, positive, text, version } from '../contracts/validation.ts';
import type { Event } from '../contracts/events.ts';
import { TaskStore } from '../store/db.ts';
import type { ArtifactRegistry } from '../artifacts/registry.ts';
import { securityHeaders, WebChannel } from '../channels/web.ts';
import type { SetupComponent } from '../setup.ts';
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

async function handle(req: IncomingMessage, res: ServerResponse, store: TaskStore, token: string, profileId: string, onError: ErrorObserver, web: WebChannel | null, briefings: BriefingProvider | undefined): Promise<void> {
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
export function createAssistantServer({ store, token, profileId, web = false, setup, artifacts, briefings, onError = () => safeLog('assistant HTTP internal request failure') }: { store: TaskStore; token: string; profileId: string; web?: boolean; setup?: () => SetupComponent[]; artifacts?: ArtifactRegistry; briefings?: BriefingProvider; onError?: ErrorObserver }): Server {
  if (!text(token) || !text(profileId) || !store.matchesProfile(profileId) || (artifacts && !artifacts.matchesProfile(profileId))) throw new TypeError('Invalid server binding');
  const channel = web ? new WebChannel({ store, token, profileId, ...(setup ? { setup } : {}), ...(artifacts ? { artifacts } : {}) }) : null;
  const server = createServer((req, res) => { void handle(req, res, store, token, profileId, onError, channel, briefings).catch(() => { reportError(onError); res.destroy(); }); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  return server;
}
