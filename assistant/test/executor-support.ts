import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { once } from 'node:events';

export type Task = { taskId: string; title: string; status: string; revision: number; inputRevision: number };
type Entry = { event: { taskId: string; channelId: string; source: { actorId: string }; evidence: { reference: string } } };

/**
 * A loopback OpenAI-compatible provider: records every request; never reached over the network.
 * A task without an answer gets a question, unless `draftsOnly`; a body containing "travar" hangs.
 */
export async function fakeProvider(options: { draftsOnly?: boolean; quickAnswers?: string[]; preview?: string } = {}) {
  const requests: string[] = [];
  const hanging: ServerResponse[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(body);
    if (body.includes('travar')) { hanging.push(res); return; }
    const answer = options.preview !== undefined ? { kind: 'browser_text', text: options.preview } : !options.draftsOnly && /\\"response\\":null/.test(body) ? { kind: 'input', text: 'Qual é o tom da mensagem?', ...(options.quickAnswers ? { options: options.quickAnswers } : {}) } : { kind: 'draft', text: 'Olá equipe, reunião amanhã às 10h.' };
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'draft', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: JSON.stringify(answer) }, null) + chunk({}, 'stop') +
      `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'draft', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { requests, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    async close() { for (const res of hanging) res.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

/** A Pi config root whose only model is the fake provider's `fixture/draft`. */
export function fixtureAgentDir(dir: string, providerUrl: string): string {
  const agentDir = join(dir, 'agent'); mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: providerUrl, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'draft' }] } } }));
  return agentDir;
}

/** The web panel as the operator uses it: a cookie session that creates tasks in `Rascunhos` and reads tasks and events. */
export async function panelSession(endpoint: string, token: string) {
  const login = await fetch(endpoint + '/web/session', { method: 'POST', headers: { origin: endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]; const { csrf } = await login.json() as { csrf: string };
  const headers = { cookie, origin: endpoint, 'x-assistant-csrf': csrf, 'content-type': 'application/json' };
  const send = (path: string, body: object) => fetch(endpoint + path, { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), channelId: 'Rascunhos', ...body }) });
  const post = async (path: string, body: object) => { const res = await send(path, body); assert.equal(res.status, 200, path); return res.json() as Promise<Task>; };
  const tasks = async () => ((await (await fetch(endpoint + '/web/api/tasks', { headers })).json()) as { tasks: Task[] }).tasks;
  const task = async (id: string) => (await tasks()).find(t => t.taskId === id)!;
  const events = async (id: string) => ((await (await fetch(endpoint + '/web/api/events?limit=100', { headers })).json()) as Entry[]).filter(e => e.event.taskId === id).map(e => e.event);
  const notes = async (id: string) => (await events(id)).filter(e => e.source.actorId === 'draft-executor').map(e => e.evidence.reference);
  const until = async (id: string, status: string, ms: number) => {
    const deadline = Date.now() + ms;
    for (;;) { const current = await task(id); if (current.status === status) return current; if (Date.now() > deadline) throw new Error(`${id} stayed ${current.status}`); await new Promise(r => setTimeout(r, 250)); }
  };
  const prompt = async (id: string) => (await (await fetch(`${endpoint}/web/api/tasks/${id}/prompt`, { headers })).json()) as { revision: number; inputRevision: number; prompt: { question: string; options: string[] } | null };
  return { send, post, tasks, task, events, notes, until, prompt };
}
