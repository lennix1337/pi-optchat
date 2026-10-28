import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseTask, type Task } from '../assistant/src/contracts/tasks.ts';
import { parseEvent } from '../assistant/src/contracts/events.ts';

export interface AssistantOwner {
  identity: object; name: string; dir: string; sessionId: string;
  zoom: (id: number, offset?: number, limit?: number) => string;
  attention: () => { approvals: number; uncertain: number; agents: number };
}
const safe = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1000);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const LIMIT = 50;

function config(owner: AssistantOwner) {
  let raw: string;
  try {
    const fd = openSync(join(owner.dir, 'assistant.json'), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Not a regular file');
      const bytes = Buffer.alloc(8193); let size = 0;
      while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
      if (size > 8192) throw new Error('Configuration too large');
      raw = bytes.subarray(0, size).toString('utf8');
    } finally { closeSync(fd); }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Assistant disabled. Add assistant.json to the active profile to enable it.');
    throw new Error('Assistant configuration unavailable.');
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (!record(v) || Object.keys(v).sort().join(',') !== 'endpoint,profileId,token,version' || v.version !== 1 || v.profileId !== owner.name || typeof v.endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(v.endpoint) || typeof v.token !== 'string' || !v.token.trim() || !/^[\x21-\x7e]+$/.test(v.token)) throw 0;
    const port = Number(v.endpoint.slice(v.endpoint.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw 0;
    return { endpoint: v.endpoint, token: v.token };
  } catch { throw new Error('Invalid assistant.json for the active profile; expected version 1 and a literal loopback endpoint.'); }
}

class HttpError extends Error { constructor(readonly status: number) { super('Assistant request failed.'); } }
class ResponseTooLarge extends Error {}
async function request(c: ReturnType<typeof config>, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(c.endpoint + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${c.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
  if (!response.body) throw new Error('Invalid response');
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 256 * 1024) throw new ResponseTooLarge(); chunks.push(value); }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original read failure. */ }
    throw error;
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
async function pagedRequest(c: ReturnType<typeof config>, path: string, params: URLSearchParams, initialLimit: number) {
  let limit = initialLimit;
  for (;;) {
    params.set('limit', String(limit));
    try { return { value: await request(c, `${path}?${params}`), limit }; }
    catch (error) {
      if (!(error instanceof ResponseTooLarge) || limit === 1) throw error;
      limit = Math.floor(limit / 2);
    }
  }
}
function task(value: unknown, owner: AssistantOwner, id?: string): Task {
  const t = parseTask(value);
  if (t.profileId !== owner.name || id !== undefined && t.taskId !== id) throw new Error('Invalid identity');
  return t;
}
const card = (t: Task) => `${encodeURIComponent(t.taskId)} · ${safe(t.title)} · ${t.status} · verification: ${t.verification} · revision ${t.revision}/${t.inputRevision}\nSource event ID: ${safe(t.sourceEventId)} (not verification)`;
function token(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!decoded.trim()) throw new Error('Invalid token');
  return decoded;
}
function integer(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid integer');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error('Invalid integer');
  return n;
}
function eventPage(value: unknown, owner: AssistantOwner, after: number, limit: number) {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid events');
  return value.map((v, i) => {
    if (!record(v) || Object.keys(v).sort().join(',') !== 'event,operation,task' || !['create', 'transition', 'respond'].includes(String(v.operation))) throw new Error('Invalid event');
    const e = parseEvent(v.event), t = task(v.task, owner);
    if (e.profileId !== owner.name || e.taskId !== t.taskId || e.sequence !== after + i + 1) throw new Error('Invalid event identity');
    return e;
  });
}
function localOriginal(ref: string, profile: string): number | undefined {
  const match = /^optchat:([^:]+):(0|[1-9][0-9]*)$/.exec(ref);
  if (!match || match[1] !== encodeURIComponent(profile)) return undefined;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) ? id : undefined;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ResponseTooLarge) return 'Assistant item exceeds the safe response size; inspect it with another bounded client.';
  if (error instanceof HttpError) return 'Assistant request failed.';
  if (error instanceof Error && (error.message.startsWith('Assistant disabled.') || error.message.startsWith('Invalid assistant.json') || error.message === 'Assistant configuration unavailable.')) return error.message;
  return 'Assistant request or response invalid; no data displayed.';
}

/** Explicit operator command; no background requests or model-facing tools. */
export function registerAssistant(pi: ExtensionAPI, source: () => AssistantOwner | undefined) {
  pi.registerCommand('assistant', { description: 'Read assistant task snapshots or respond to a current input request', handler: async (args, ctx) => {
    const words = args.trim().split(/\s+/).filter(Boolean), action = words[0] ?? 'list';
    const arity: Record<string, readonly number[]> = { list: [0, 1, 2], show: [2], respond: [2], evidence: [2, 3], original: [3, 4] };
    if (!Object.hasOwn(arity, action) || !arity[action].includes(words.length)) { ctx.ui.notify('Usage: /assistant [list [cursor]|show <id>|respond <id>|evidence <id> [afterSequence]|original <id> <eventSequence> [offset]] (IDs and cursors URL-encoded)', 'error'); return; }
    const owner = source();
    if (!owner || owner.sessionId !== ctx.sessionManager.getSessionId()) { ctx.ui.notify('Open an available local profile before /assistant.', 'error'); return; }
    const stillOwned = () => { const current = source(); return current?.identity === owner.identity && current.name === owner.name && current.sessionId === owner.sessionId && ctx.sessionManager.getSessionId() === owner.sessionId; };
    let write = false;
    try {
      const c = config(owner);
      if (action === 'list') {
        const query = new URLSearchParams(); if (words[1]) query.set('cursor', token(words[1]));
        const { value: page, limit } = await pagedRequest(c, '/v1/tasks', query, LIMIT);
        if (!record(page) || Object.keys(page).sort().join(',') !== 'nextCursor,tasks' || !Array.isArray(page.tasks) || page.tasks.length > limit || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0)) throw new Error('Invalid page');
        const tasks = page.tasks.map(v => task(v, owner));
        if (!stillOwned()) throw new Error('Owner changed');
        ctx.ui.notify([`Assistant snapshots · ${tasks.length} tasks (metadata, not work or effect success)`, ...tasks.map(card), page.nextCursor === null ? 'End of page.' : `Continue: /assistant list ${encodeURIComponent(page.nextCursor as string)}`].join('\n'), 'info'); return;
      }
      const id = token(words[1]), current = task(await request(c, `/v1/tasks/${encodeURIComponent(id)}`), owner, id);
      if (!stillOwned()) throw new Error('Owner changed');
      if (action === 'show') {
        const a = owner.attention();
        ctx.ui.notify(`${card(current)}\nLocal owner journals (not exhaustive): ${a.approvals} approvals (/approve, /deny), ${a.uncertain} uncertain operations (operation_state), ${a.agents} agents (/optchat agents). No grants copied.`, 'info'); return;
      }
      if (action === 'evidence' || action === 'original') {
        const original = action === 'original';
        const sequence = original ? integer(words[2], 0, 1) : integer(words[2], 0, 0);
        const offset = original ? integer(words[3], 0, 0) : 0;
        const after = original ? sequence - 1 : sequence;
        const { value, limit } = await pagedRequest(c, '/v1/events', new URLSearchParams({ after: String(after) }), original ? 1 : LIMIT);
        const events = eventPage(value, owner, after, limit);
        if (!stillOwned()) throw new Error('Owner changed');
        if (original) {
          const event = events[0];
          if (!event || event.taskId !== id) throw new Error('Invalid original event');
          const ref = event.evidence.reference, messageId = localOriginal(ref, owner.name);
          if (messageId === undefined) { ctx.ui.notify('Foreign or unsupported reference; not opened (unverified).', 'warning'); return; }
          const page = owner.zoom(messageId, offset, 6000).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
          ctx.ui.notify(`Historical original · ${ref} · unverified source
${page}
Continue with /assistant original ${encodeURIComponent(id)} ${sequence} <offset> using the next page offset above.`, 'info'); return;
        }
        const lines = [card(current), `Observed references, not verification · profile events after ${after}.`];
        for (const event of events.filter(e => e.taskId === id)) {
          const ref = event.evidence.reference;
          lines.push(`Sequence ${event.sequence} · source event ID: ${safe(event.source.sourceEventId)} · evidence reference: ${safe(ref)} (unverified)`);
          if (localOriginal(ref, owner.name) !== undefined) lines.push(`Open: /assistant original ${encodeURIComponent(id)} ${event.sequence}`);
          else lines.push('Foreign or unsupported reference; not opened.');
        }
        if (events.length === limit) lines.push(`Continue: /assistant evidence ${encodeURIComponent(id)} ${after + events.length}`);
        else lines.push('End of profile events.');
        ctx.ui.notify(lines.join('\n'), 'info'); return;
      }
      if (ctx.mode !== 'tui' || !ctx.hasUI) { ctx.ui.notify('Respond requires interactive Pi.', 'error'); return; }
      if (current.status !== 'needs_input') { ctx.ui.notify('Task does not currently need input. Refresh first.', 'warning'); return; }
      const text = await ctx.ui.input(`Respond to ${safe(current.taskId)} · revision ${current.revision}/${current.inputRevision}`);
      if (text === undefined || !text.trim()) { ctx.ui.notify('Response cancelled.', 'info'); return; }
      const latest = source();
      if (!latest || latest.identity !== owner.identity || latest.name !== owner.name || latest.sessionId !== owner.sessionId || ctx.sessionManager.getSessionId() !== owner.sessionId) { ctx.ui.notify('Profile or session changed; response not sent.', 'warning'); return; }
      const sourceEventId = randomUUID(); write = true;
      const result = await request(c, `/v1/tasks/${encodeURIComponent(id)}/respond`, { response: { version: 1, profileId: owner.name, taskId: id, revision: current.revision, inputRevision: current.inputRevision, text }, context: { sessionId: owner.sessionId, channelId: 'pi-terminal', runId: sourceEventId, sourceEventId, evidenceReference: `assistant-response:${sourceEventId}` } });
      task(result, owner, id);
      if (!stillOwned()) throw new Error('Owner changed');
      ctx.ui.notify('Response recorded as data, not authorization or verified work.', 'info');
    } catch (error) {
      ctx.ui.notify(write ? error instanceof HttpError && error.status === 409 ? 'Response is stale. Refresh the task before responding; no automatic retry.' : 'Response outcome uncertain. Inspect current state before any further action; do not automatically retry.'
        : readErrorMessage(error), 'error');
    }
  } });
}
