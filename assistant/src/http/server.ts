import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseTask, type TaskResponse, type TaskStatus } from '../contracts/tasks.ts';
import { object, oneOf, positive, text, version } from '../contracts/validation.ts';
import type { Event } from '../contracts/events.ts';
import { TaskStore } from '../store/db.ts';
import { authenticate } from './auth.ts';

const maxBody = 64 * 1024;
const bodyIdleMs = 2_000;
const bodyDeadlineMs = 5_000;
type Diagnostic = { category: 'internal'; operation: 'request' };
type ErrorObserver = (diagnostic: Diagnostic) => void | Promise<void>;
function safeLog(message: string): void {
  try { console.error(message); } catch { /* Diagnostics must not disrupt the request. */ }
}
function reportError(observer: ErrorObserver): void {
  try {
    Promise.resolve(observer({ category: 'internal', operation: 'request' })).catch(() => safeLog('assistant HTTP diagnostic observer failed'));
  } catch { safeLog('assistant HTTP diagnostic observer failed'); }
}
const statuses = oneOf('suggested', 'queued', 'working', 'needs_input', 'ready_for_review', 'succeeded', 'failed', 'cancelled', 'resolved');
type Context = { sessionId: string; channelId: string; runId: string; sourceEventId: string; evidenceReference: string };
class BadRequest extends Error {}
class Conflict extends Error {}
function mutation<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof TypeError || (typeof error === 'object' && error !== null && 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 255) === 19)) throw new Conflict();
    throw error;
  }
}

function shape(value: unknown, schema: Parameters<typeof object>[1]): void {
  try { object(value, schema); } catch (error) { if (error instanceof TypeError) throw new BadRequest(); throw error; }
}
function send(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new BadRequest();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let idle: NodeJS.Timeout;
    const deadline = setTimeout(refuse, bodyDeadlineMs);
    function cleanup(): void {
      clearTimeout(idle); clearTimeout(deadline);
      req.off('data', data); req.off('end', end); req.off('error', interrupted); req.off('aborted', interrupted);
    }
    function refuse(): void { cleanup(); req.destroy(); reject(new BadRequest()); }
    function interrupted(): void { cleanup(); reject(new BadRequest()); }
    function resetIdle(): void { clearTimeout(idle); idle = setTimeout(refuse, bodyIdleMs); }
    function data(chunk: Buffer): void {
      size += chunk.length;
      if (size > maxBody) { refuse(); return; }
      chunks.push(chunk); resetIdle();
    }
    function end(): void { cleanup(); resolve(Buffer.concat(chunks)); }
    req.on('data', data); req.once('end', end); req.once('error', interrupted); req.once('aborted', interrupted);
    resetIdle();
  });
  try { return JSON.parse(bytes.toString('utf8')); } catch (error) { if (error instanceof SyntaxError) throw new BadRequest(); throw error; }
}
function query(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new BadRequest();
}
function numberParam(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new BadRequest();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new BadRequest();
  return value;
}
function event(store: TaskStore, profileId: string, taskId: string, context: Context): Event {
  return { version: 1, eventId: randomUUID(), correlationId: randomUUID(), profileId, taskId, sessionId: context.sessionId, channelId: context.channelId, runId: context.runId, source: { actorId: 'assistant-client', sourceKind: 'model', sourceEventId: context.sourceEventId }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), evidence: { kind: 'observed', reference: context.evidenceReference } };
}
const contextSchema = { sessionId: text, channelId: text, runId: text, sourceEventId: text, evidenceReference: text };
const responseSchema = { version, profileId: text, taskId: text, revision: positive, inputRevision: positive, text };

export function isAllowedRemote(address: string | undefined): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '');
}
async function handle(req: IncomingMessage, res: ServerResponse, store: TaskStore, token: string, profileId: string, onError: ErrorObserver): Promise<void> {
  try {
    if (!isAllowedRemote(req.socket.remoteAddress) || req.headers.origin !== undefined) { send(res, 403, { error: 'Forbidden' }); return; }
    if (!authenticate(req.headers.authorization, token)) { send(res, 401, { error: 'Unauthorized' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/v1\/tasks\/([^/]+)(?:\/(transition|respond))?$/.exec(url.pathname);
    let id: string | undefined;
    if (match) { try { id = decodeURIComponent(match[1]); } catch (error) { if (error instanceof URIError) throw new BadRequest(); throw error; } if (!text(id)) throw new BadRequest(); }
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
export function createAssistantServer({ store, token, profileId, onError = () => safeLog('assistant HTTP internal request failure') }: { store: TaskStore; token: string; profileId: string; onError?: ErrorObserver }): Server {
  if (!text(token) || !text(profileId) || !store.matchesProfile(profileId)) throw new TypeError('Invalid server binding');
  const server = createServer((req, res) => { void handle(req, res, store, token, profileId, onError).catch(() => { reportError(onError); res.destroy(); }); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  return server;
}
