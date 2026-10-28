import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseTask, type Task } from '../assistant/src/contracts/tasks.ts';
import { parseEvent } from '../assistant/src/contracts/events.ts';

export interface AssistantOwner {
  identity: object; name: string; dir: string; sessionId: string;
  zoom: (id: number) => string;
  attention: () => { approvals: number; uncertain: number; agents: number };
}
const safe = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1000);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const LIMIT = 50;

function config(owner: AssistantOwner) {
  let raw: string;
  try { raw = readFileSync(join(owner.dir, 'assistant.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Assistant disabled. Add assistant.json to the active profile to enable it.');
    throw new Error('Assistant configuration unavailable.');
  }
  try {
    if (raw.length > 8192) throw 0;
    const v: unknown = JSON.parse(raw);
    if (!record(v) || Object.keys(v).sort().join(',') !== 'endpoint,profileId,token,version' || v.version !== 1 || v.profileId !== owner.name || typeof v.endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(v.endpoint) || typeof v.token !== 'string' || !v.token.trim() || !/^[\x21-\x7e]+$/.test(v.token)) throw 0;
    const port = Number(v.endpoint.slice(v.endpoint.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw 0;
    return { endpoint: v.endpoint, token: v.token };
  } catch { throw new Error('Invalid assistant.json for the active profile; expected version 1 and a literal loopback endpoint.'); }
}

class HttpError extends Error { constructor(readonly status: number) { super('Assistant request failed.'); } }
async function request(c: ReturnType<typeof config>, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(c.endpoint + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${c.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
  if (!response.body) throw new Error('Invalid response');
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 256 * 1024) throw new Error('Response too large'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
function task(value: unknown, owner: AssistantOwner, id?: string): Task {
  const t = parseTask(value);
  if (t.profileId !== owner.name || id !== undefined && t.taskId !== id) throw new Error('Invalid identity');
  return t;
}
const card = (t: Task) => `${safe(t.taskId)} · ${safe(t.title)} · ${t.status} · verification: ${t.verification} · revision ${t.revision}/${t.inputRevision}\nSource event ID: ${safe(t.sourceEventId)} (not verification)`;

/** Explicit operator command; no background requests or model-facing tools. */
export function registerAssistant(pi: ExtensionAPI, source: () => AssistantOwner | undefined) {
  pi.registerCommand('assistant', { description: 'Read assistant task snapshots or respond to a current input request', handler: async (args, ctx) => {
    const words = args.trim().split(/\s+/).filter(Boolean), action = words[0] ?? 'list';
    if (!(['list', 'show', 'respond', 'evidence'].includes(action)) || words.length > 2 || action !== 'list' && words.length !== 2) { ctx.ui.notify('Usage: /assistant [list [cursor]|show <id>|respond <id>|evidence <id>]', 'error'); return; }
    const owner = source();
    if (!owner || owner.sessionId !== ctx.sessionManager.getSessionId()) { ctx.ui.notify('Open an available local profile before /assistant.', 'error'); return; }
    const stillOwned = () => { const current = source(); return current?.identity === owner.identity && current.name === owner.name && current.sessionId === owner.sessionId && ctx.sessionManager.getSessionId() === owner.sessionId; };
    let write = false;
    try {
      const c = config(owner);
      if (action === 'list') {
        const query = new URLSearchParams({ limit: String(LIMIT) }); if (words[1]) query.set('cursor', words[1]);
        const page = await request(c, `/v1/tasks?${query}`);
        if (!record(page) || Object.keys(page).sort().join(',') !== 'nextCursor,tasks' || !Array.isArray(page.tasks) || page.tasks.length > LIMIT || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0)) throw new Error('Invalid page');
        const tasks = page.tasks.map(v => task(v, owner));
        if (!stillOwned()) throw new Error('Owner changed');
        ctx.ui.notify([`Assistant snapshots · ${tasks.length} tasks (metadata, not work or effect success)`, ...tasks.map(card), page.nextCursor === null ? 'End of page.' : `Continue: /assistant list ${safe(page.nextCursor as string)}`].join('\n'), 'info'); return;
      }
      const id = words[1], current = task(await request(c, `/v1/tasks/${encodeURIComponent(id)}`), owner, id);
      if (!stillOwned()) throw new Error('Owner changed');
      if (action === 'show') {
        const a = owner.attention();
        ctx.ui.notify(`${card(current)}\nLocal owner journals (not exhaustive): ${a.approvals} approvals (/approve, /deny), ${a.uncertain} uncertain operations (operation_state), ${a.agents} agents (/optchat agents). No grants copied.`, 'info'); return;
      }
      if (action === 'evidence') {
        const events = await request(c, `/v1/events?after=0&limit=${LIMIT}`);
        if (!Array.isArray(events) || events.length > LIMIT) throw new Error('Invalid events');
        const matches = events.map((v, i) => {
          if (!record(v) || Object.keys(v).sort().join(',') !== 'event,operation,task' || !['create', 'transition', 'respond'].includes(String(v.operation))) throw new Error('Invalid event');
          const e = parseEvent(v.event), t = task(v.task, owner);
          if (e.profileId !== owner.name || e.taskId !== t.taskId || e.sequence !== i + 1) throw new Error('Invalid event identity');
          return e;
        }).filter(e => e.taskId === id);
        if (!stillOwned()) throw new Error('Owner changed');
        const lines = [card(current), 'Original references below are observed, not verified. First 50 profile events only.'];
        for (const e of matches) {
          const ref = e.evidence.reference; lines.push(`Source event ID: ${safe(e.source.sourceEventId)} · evidence reference: ${safe(ref)} (unverified)`);
          const match = /^optchat:([^:]+):(0|[1-9][0-9]*)$/.exec(ref);
          if (match) {
            let profile = ''; try { profile = decodeURIComponent(match[1]); } catch { /* unsupported reference */ }
            const n = Number(match[2]);
            if (profile === owner.name && encodeURIComponent(profile) === match[1] && Number.isSafeInteger(n)) {
              try { lines.push(`Original message ${n}:\n${safe(owner.zoom(n))}`); } catch { lines.push('Original message unavailable.'); }
            } else lines.push('Foreign or invalid original reference; not opened.');
          } else lines.push('Unsupported reference; not opened.');
        }
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
      ctx.ui.notify('Response recorded as data, not authorization or verified work.', 'info');
    } catch (error) {
      ctx.ui.notify(write ? error instanceof HttpError && error.status === 409 ? 'Response is stale. Refresh the task before responding; no automatic retry.' : 'Response outcome uncertain. Inspect current state before any further action; do not automatically retry.'
        : error instanceof HttpError ? 'Assistant request failed.' : error instanceof Error && (error.message.startsWith('Assistant disabled.') || error.message.startsWith('Invalid assistant.json') || error.message === 'Assistant configuration unavailable.') ? error.message : 'Assistant request or response invalid; no data displayed.', 'error');
    }
  } });
}
