import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { TaskStore } from '../assistant/src/store/db.ts';
import { createAssistantServer } from '../assistant/src/http/server.ts';
import { registerAssistant } from '../src/assistant-client.ts';

test('real server paginates large valid snapshots and contiguous events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-pages-'));
  const store = new TaskStore(join(dir, 'db'), 'p');
  for (let i = 1; i <= 5; i++) {
    const sourceEventId = `source${i}`;
    store.create({ version: 1, profileId: 'p', taskId: `t${i}`, title: 'x'.repeat(60 * 1024), status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId },
      { version: 1, eventId: `e${i}`, profileId: 'p', sessionId: 's', channelId: 'c', taskId: `t${i}`, runId: 'r', source: { actorId: 'a', sourceKind: 'model', sourceEventId }, observedAt: '2026-01-01T00:00:00Z', sequence: i, correlationId: 'c', evidence: { kind: 'observed', reference: 'optchat:p:0' } });
  }
  const server = createAssistantServer({ store, token: 'secret', profileId: 'p' });
  const requests: string[] = []; server.on('request', req => requests.push(`${req.method} ${req.url}`));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  writeFileSync(join(dir, 'assistant.json'), JSON.stringify({ version: 1, profileId: 'p', endpoint: `http://127.0.0.1:${address.port}`, token: 'secret' }));
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>; const output: string[] = [];
  const pi = { registerCommand: (_: string, options: { handler: typeof handler }) => { handler = options.handler; } } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getSessionId: () => 's' }, ui: { notify: (s: string) => output.push(s) } } as unknown as ExtensionCommandContext;
  registerAssistant(pi, () => ({ identity, name: 'p', dir, sessionId: 's', zoom: () => 'original', attention: () => ({ approvals: 0, uncertain: 0, agents: 0 }) }));
  try {
    await handler('list', ctx); const first = output.pop()!; assert.match(first, /Continue: \/assistant list /);
    assert.deepEqual(requests.map(r => new URL(r.slice(4), 'http://127.0.0.1').searchParams.get('limit')), ['50', '25', '12', '6', '3']);
    const cursor = /Continue: \/assistant list (\S+)/.exec(first)![1];
    await handler(`list ${cursor}`, ctx); assert.match(output.pop()!, /End of page/);
    const beforeEvents = requests.length;
    await handler('evidence t1', ctx); const events = output.pop()!; assert.match(events, /Sequence 1/); const after = /Continue: \/assistant evidence t1 (\d+)/.exec(events)![1]; assert.equal(after, '3');
    assert.deepEqual(requests.slice(beforeEvents + 1).map(r => new URL(r.slice(4), 'http://127.0.0.1').searchParams.get('limit')), ['50', '25', '12', '6', '3']);
    await handler(`evidence t1 ${after}`, ctx); assert.match(output.pop()!, /End of profile events/);
    await handler('original t1 1', ctx); assert.match(output.pop()!, /Historical original/);
    assert(requests.every(r => r.startsWith('GET '))); assert(requests.length <= 20);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
const identity = {};
