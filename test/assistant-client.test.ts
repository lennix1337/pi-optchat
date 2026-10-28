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
  let stale = false, foreign = false, redirect = false, unauthorized = false, oversized = false, abortWrite = false, foreignEvent = false, malformedEvent = false; let session = 'session'; let ref = 'optchat:p:0'; let onWrite = () => {}; let zooms = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (redirect) { res.statusCode = 302; res.setHeader('Location', 'http://127.0.0.1:1/'); res.end(); return; }
    if (unauthorized) { res.statusCode = 401; res.end('{}'); return; }
    if (oversized) { res.write(' '.repeat(150000)); res.end(' '.repeat(150000)); return; }
    if (req.url?.startsWith('/v1/events?')) {
      const query = new URL(req.url, 'http://127.0.0.1').searchParams, after = Number(query.get('after')), limit = Number(query.get('limit'));
      const count = after === 0 && limit === 50 ? 50 : 1;
      const events = Array.from({ length: count }, (_, i) => ({ operation: 'create', task, event: { version: 1, eventId: 'e', profileId: foreignEvent ? 'other' : 'p', sessionId: 's', channelId: 'c', taskId: task.taskId, runId: 'r', source: { actorId: 'x', sourceKind: 'model', sourceEventId: 'origin' }, observedAt: '2026-01-01T00:00:00Z', sequence: after + i + (malformedEvent ? 2 : 1), correlationId: 'x', evidence: { kind: 'observed', reference: ref } } }));
      res.end(JSON.stringify(events)); return;
    }
    if (req.method === 'POST') { onWrite(); if (abortWrite) { req.socket.destroy(); return; } if (stale) { res.statusCode = 409; res.end('{}'); return; } res.end(JSON.stringify({ ...task, status: 'working', revision: 3 })); return; }
    if (req.url?.startsWith('/v1/tasks?')) { res.end(JSON.stringify({ tasks: [task], nextCursor: 'next' })); return; }
    res.end(JSON.stringify(foreign ? { ...task, profileId: 'other' } : task));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const output: string[] = []; let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const pi = { registerCommand: (_name: string, options: { handler: typeof handler }) => { handler = options.handler; } } as unknown as ExtensionAPI;
  let owner: AssistantOwner = { identity: {}, name: 'p', dir, sessionId: 'session', zoom: (_id, offset) => { zooms++; return `original\n${'x'.repeat(2000)}\n[showing characters ${offset}-6000 of 9000; next page: offset 6000]`; }, attention: () => ({ approvals: 0, uncertain: 0, agents: 0 }) };
  let input = async () => 'private answer';
  const ctx = { mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => session }, ui: { notify: (s: string) => output.push(s), input: () => input() } } as unknown as ExtensionCommandContext;
  registerAssistant(pi, () => owner);
  try {
    for (const invalid of ['toString', 'constructor', '__proto__']) {
      await handler(invalid, ctx); assert.match(output.pop()!, /Usage:/);
    }
    await handler('list', ctx); assert.equal(calls.length, 0); assert.match(output.pop()!, /disabled/);
    const save = (endpoint: string) => writeFileSync(join(dir, 'assistant.json'), JSON.stringify({ version: 1, profileId: 'p', endpoint, token: 'secret' }));
    save('http://localhost:1234'); await handler('list', ctx); assert.equal(calls.length, 0);
    save(`http://127.0.0.1:${address.port}`);
    await handler('list', ctx); assert.match(output.pop()!, /Continue: \/assistant list next/);
    await handler('list next', ctx); assert.match(calls.at(-1)!.url!, /cursor=next/);
    foreign = true; await handler('show a', ctx); assert.match(output.pop()!, /invalid/); foreign = false;
    task.taskId = "sql / ' %"; const encoded = encodeURIComponent(task.taskId);
    await handler(`show ${encoded}`, ctx); assert.match(output.pop()!, /sql%20%2F/); assert.equal(calls.at(-1)!.url, `/v1/tasks/${encoded}`);
    await handler(`evidence ${encoded} 50`, ctx); assert.match(output.pop()!, new RegExp(`original ${encoded} 51`));
    await handler('show %ZZ', ctx); assert.match(output.pop()!, /invalid/); task.taskId = 'a';
    input = async () => { owner = { ...owner, identity: {} }; return 'private answer'; };
    await handler('respond a', ctx); assert.equal(calls.filter(c => c.method === 'POST').length, 0);
    input = async () => { session = 'other'; return 'private answer'; }; await handler('respond a', ctx); assert.equal(calls.filter(c => c.method === 'POST').length, 0); session = 'session';
    input = async () => ''; await handler('respond a', ctx); assert.equal(calls.filter(c => c.method === 'POST').length, 0);
    await handler('evidence a', ctx); assert.match(output.pop()!, /Continue: \/assistant evidence a 50/); assert.equal(zooms, 0);
    await handler('evidence a 50', ctx); assert.match(output.pop()!, /Sequence 51/);
    await handler('original a 51', ctx); const original = output.pop()!; assert(original.includes('x'.repeat(2000))); assert.match(original, /next page: offset 6000/); assert.equal(zooms, 1);
    ref = 'optchat:foreign:0'; await handler('original a 51', ctx); assert.match(output.pop()!, /not opened/); assert.equal(zooms, 1);
    ref = 'optchat:%ZZ:0'; await handler('original a 51', ctx); assert.match(output.pop()!, /not opened/); assert.equal(zooms, 1);
    foreignEvent = true; await handler('evidence a 50', ctx); assert.match(output.pop()!, /invalid/); foreignEvent = false;
    malformedEvent = true; await handler('original a 51', ctx); assert.match(output.pop()!, /invalid/); malformedEvent = false; assert.equal(zooms, 1);
    unauthorized = true; await handler('list', ctx); assert.match(output.pop()!, /failed/); unauthorized = false;
    oversized = true; await handler('list', ctx); assert.match(output.pop()!, /invalid/); oversized = false;
    redirect = true; await handler('list', ctx); assert.match(output.pop()!, /invalid/); redirect = false;
    input = async () => 'private answer'; stale = true; await handler('respond a', ctx); assert.match(output.pop()!, /stale/);
    stale = false; await handler('respond a', ctx); assert.match(output.pop()!, /not authorization/);
    assert(calls.at(-1)!.body.includes('private answer'));
    abortWrite = true; const before = calls.filter(c => c.method === 'POST').length; await handler('respond a', ctx); assert.match(output.pop()!, /uncertain/); assert.equal(calls.filter(c => c.method === 'POST').length, before + 1); abortWrite = false;
    onWrite = () => { owner = { ...owner, identity: {} }; }; await handler('respond a', ctx); assert.match(output.pop()!, /uncertain/); onWrite = () => {};
    assert(!output.join('\n').includes('private answer')); assert(!output.join('\n').includes('secret'));
    assert(calls.filter(c => c.method === 'POST').every(c => c.url === '/v1/tasks/a/respond'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('disposable mutations defeat profile and post-input guards', async () => {
  const { readFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'assistant-mutation-'));
  const original = readFileSync(new URL('../src/assistant-client.ts', import.meta.url), 'utf8')
    .replaceAll("'../assistant/src/contracts/tasks.ts'", JSON.stringify(new URL('../assistant/src/contracts/tasks.ts', import.meta.url).href))
    .replaceAll("'../assistant/src/contracts/events.ts'", JSON.stringify(new URL('../assistant/src/contracts/events.ts', import.meta.url).href));
  const task = { version: 1, profileId: 'p', taskId: 'a', title: 'Task', status: 'needs_input', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: 'origin' };
  let posts = 0;
  const server = createServer((req, res) => { if (req.method === 'POST') posts++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url?.includes('/events?') ? [{ operation: 'create', task, event: { version: 1, eventId: 'e', profileId: 'foreign', sessionId: 's', channelId: 'c', taskId: 'a', runId: 'r', source: { actorId: 'x', sourceKind: 'model', sourceEventId: 'origin' }, observedAt: '2026-01-01T00:00:00Z', sequence: 1, correlationId: 'x', evidence: { kind: 'observed', reference: 'optchat:p:0' } } }] : task)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  writeFileSync(join(dir, 'assistant.json'), JSON.stringify({ version: 1, profileId: 'p', endpoint: `http://127.0.0.1:${address.port}`, token: 'secret' }));
  try {
    for (const [index, mutation] of [
      [0, (s: string) => s.replace('e.profileId !== owner.name || ', '')],
      [1, (s: string) => s.replace('latest.identity !== owner.identity || ', '')],
    ] as const) {
      const changed = mutation(original); assert.notEqual(changed, original); const file = join(dir, `mutant${index}.ts`); writeFileSync(file, changed);
      const mod = await import(pathToFileURL(file).href) as typeof import('../src/assistant-client.ts');
      let owner: AssistantOwner = { identity: {}, name: 'p', dir, sessionId: 's', zoom: () => '', attention: () => ({ approvals: 0, uncertain: 0, agents: 0 }) };
      let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>; const messages: string[] = [];
      const pi = { registerCommand: (_name: string, options: { handler: typeof handler }) => { handler = options.handler; } } as unknown as ExtensionAPI;
      const ctx = { mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => 's' }, ui: { notify: (s: string) => messages.push(s), input: async () => { owner = { ...owner, identity: {} }; return 'private'; } } } as unknown as ExtensionCommandContext;
      mod.registerAssistant(pi, () => owner);
      if (index === 0) { await handler('evidence a', ctx); assert.match(messages.at(-1)!, /Sequence 1/); }
      else { await handler('respond a', ctx); assert.equal(posts, 1); }
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
