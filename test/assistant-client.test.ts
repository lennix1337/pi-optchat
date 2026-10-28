import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerAssistant, type AssistantOwner } from '../src/assistant-client.ts';

test('registered command uses loopback, guards owner, and keeps response private', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-client-')); const calls: { method?: string; url?: string; body: string }[] = [];
  const task = { version: 1, profileId: 'p', taskId: 'a', title: 'Task', status: 'needs_input', verification: 'not_verified', revision: 2, inputRevision: 3, sourceEventId: 'origin' };
  let stale = false, foreign = false, redirect = false; let session = 'session'; let ref = 'optchat:p:0';
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (redirect) { res.statusCode = 302; res.setHeader('Location', 'http://127.0.0.1:1/'); res.end(); return; }
    if (req.url?.startsWith('/v1/events?')) { res.end(JSON.stringify([{ operation: 'create', task, event: { version: 1, eventId: 'e', profileId: 'p', sessionId: 's', channelId: 'c', taskId: 'a', runId: 'r', source: { actorId: 'x', sourceKind: 'model', sourceEventId: 'origin' }, observedAt: '2026-01-01T00:00:00Z', sequence: 1, correlationId: 'x', evidence: { kind: 'observed', reference: ref } } }])); return; }
    if (req.method === 'POST') { if (stale) { res.statusCode = 409; res.end('{}'); return; } res.end(JSON.stringify({ ...task, status: 'working', revision: 3 })); return; }
    if (req.url?.startsWith('/v1/tasks?')) { res.end(JSON.stringify({ tasks: [task], nextCursor: 'next' })); return; }
    res.end(JSON.stringify(foreign ? { ...task, profileId: 'other' } : task));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const output: string[] = []; let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const pi = { registerCommand: (_name: string, options: { handler: typeof handler }) => { handler = options.handler; } } as unknown as ExtensionAPI;
  let owner: AssistantOwner = { identity: {}, name: 'p', dir, sessionId: 'session', zoom: () => 'original', attention: () => ({ approvals: 0, uncertain: 0, agents: 0 }) };
  let input = async () => 'private answer';
  const ctx = { mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => session }, ui: { notify: (s: string) => output.push(s), input: () => input() } } as unknown as ExtensionCommandContext;
  registerAssistant(pi, () => owner);
  try {
    await handler('list', ctx); assert.equal(calls.length, 0); assert.match(output.pop()!, /disabled/);
    const save = (endpoint: string) => writeFileSync(join(dir, 'assistant.json'), JSON.stringify({ version: 1, profileId: 'p', endpoint, token: 'secret' }));
    save('http://localhost:1234'); await handler('list', ctx); assert.equal(calls.length, 0);
    save(`http://127.0.0.1:${address.port}`);
    await handler('list', ctx); assert.match(output.pop()!, /Continue: \/assistant list next/);
    await handler('list next', ctx); assert.match(calls.at(-1)!.url!, /cursor=next/);
    foreign = true; await handler('show a', ctx); assert.match(output.pop()!, /invalid/); foreign = false;
    input = async () => { owner = { ...owner, identity: {} }; return 'private answer'; };
    await handler('respond a', ctx); assert.equal(calls.filter(c => c.method === 'POST').length, 0);
    input = async () => { session = 'other'; return 'private answer'; }; await handler('respond a', ctx); assert.equal(calls.filter(c => c.method === 'POST').length, 0); session = 'session';
    input = async () => ''; await handler('respond a', ctx); assert.equal(calls.filter(c => c.method === 'POST').length, 0);
    await handler('evidence a', ctx); assert.match(output.pop()!, /Original message 0/);
    ref = 'optchat:foreign:0'; await handler('evidence a', ctx); assert.match(output.pop()!, /not opened/);
    ref = 'https://example.com'; await handler('evidence a', ctx); assert.match(output.pop()!, /Unsupported reference/);
    redirect = true; await handler('list', ctx); assert.match(output.pop()!, /invalid/); redirect = false;
    input = async () => 'private answer'; stale = true; await handler('respond a', ctx); assert.match(output.pop()!, /stale/);
    stale = false; await handler('respond a', ctx); assert.match(output.pop()!, /not authorization/);
    assert(!output.join('\n').includes('private answer')); assert(calls.at(-1)!.body.includes('private answer'));
    assert(calls.filter(c => c.method === 'POST').every(c => c.url === '/v1/tasks/a/respond'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
