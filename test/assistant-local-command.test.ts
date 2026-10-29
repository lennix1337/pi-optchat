import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerAssistant, type AssistantOwner } from '../src/assistant-client.ts';
import { projectLocalInbox } from '../src/assistant-projection.ts';
import { EffectApprovals } from '../src/authorization.ts';
import { OperationJournal } from '../src/operations.ts';
import type { RunInfo } from '../src/runs.ts';

test('registered local inbox works without service config and preserves canonical journals/grants', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-local-'));
  const gate = new EffectApprovals({ mode: 'all' });
  gate.admit({ session: 's', cwd: dir, tool: 'write', input: { path: 'file', content: 'CANARY-SECRET' } });
  const journal = new OperationJournal(dir);
  journal.start('s', 'call', 'write', { private: 'CANARY-SECRET' });
  const operations = journal.snapshot(), approvals = gate.pendingFor('s');
  const runs: RunInfo[] = Array.from({ length: 27 }, (_, i) => ({ id: `run-${i}`, parentSession: 's', state: 'failed', task: 'CANARY-SECRET', cwd: '', model: '', thinking: '', started: 0, depth: 1, guidance: [] }));
  const before = JSON.stringify(runs), notices: string[] = [];
  let requests = 0, sessionId = 's';
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('No network allowed'); });
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const pi = { registerCommand: (_: string, options: { handler: typeof handler }) => { handler = options.handler; } } as unknown as ExtensionAPI;
  const owner: AssistantOwner = { identity: {}, name: 'p', sessionId: 's', dir, zoom: () => '', attention: () => ({ approvals: 1, uncertain: 1, agents: 27 }),
    localInbox: cursor => projectLocalInbox({ profileId: 'p', sessionId: 's', approvals: gate.pendingFor('s'), operations: journal.snapshot(), runs }, cursor) };
  registerAssistant(pi, () => owner);
  const ctx = { sessionManager: { getSessionId: () => sessionId }, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
  try {
    await handler('local', ctx);
    assert.match(notices.at(-1)!, /Local inbox/);
    const cursor = /Continue: \/assistant local (\S+)/.exec(notices.at(-1)!)![1];
    await handler(`local ${cursor}`, ctx);
    assert.match(notices.at(-1)!, /operation ID: "s:call"/);
    await handler('list', ctx);
    assert.match(notices.at(-1)!, /Local inbox[\s\S]*Assistant disabled/);
    assert.ok(!notices.join('\n').includes('CANARY-SECRET'));
    assert.ok(!notices.join('\n').includes(approvals[0].token));
    assert.doesNotMatch(notices.join('\n'), /inspect: \/approve|operation_state \{"id"/);
    assert.deepEqual(journal.snapshot(), operations);
    assert.deepEqual(gate.pendingFor('s'), approvals);
    assert.equal(JSON.stringify(runs), before);
    sessionId = 'foreign'; await handler('local', ctx);
    assert.match(notices.at(-1)!, /Open an available local profile/);
    assert.equal(requests, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
