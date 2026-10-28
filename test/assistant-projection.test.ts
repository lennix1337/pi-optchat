import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectLocalInbox, renderLocalInbox } from '../src/assistant-projection.ts';
import type { RunInfo } from '../src/runs.ts';

const run = (id: string, parentSession: string, state: RunInfo['state'] = 'completed', source?: 'pi-subagents'): RunInfo => ({ id, parentSession, state, source, task: 'secret-task', report: 'secret-report', cwd: '', model: '', thinking: '', started: 0, depth: 1, guidance: [] });
const sources = () => ({ profileId: 'profile-a', sessionId: 'session-a',
  approvals: [{ token: 'secret-token', tool: 'bash', summary: 'secret-credential\n\x1b[31m', expires: 1 }],
  operations: [{ id: 'session-a:call', status: 'started' as const, error: true, evidence: 'secret-evidence', tool: 'secret-args' }, { id: 'other:call', status: 'started' as const }],
  runs: [run('run-a', 'session-a', 'failed'), run('other', 'session-b'), run('external', '', 'completed', 'pi-subagents')],
});

test('projection is scoped, read-only, inspectable and excludes sensitive source text', () => {
  const input = sources(), original = JSON.stringify(input);
  const page = projectLocalInbox(input);
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(page.rows.map(row => row.source).sort(), ['agent', 'approval', 'external-agent', 'operation']);
  assert.ok(page.rows.every(row => row.verification === 'not_verified'));
  const approval = page.rows.find(row => row.source === 'approval')!;
  assert.deepEqual(approval.reference, { type: 'approval', tool: 'bash', expires: 1 });
  assert.ok(!renderLocalInbox(page).includes('/approve'));
  assert.deepEqual(page.rows.find(row => row.source === 'operation')!.reference, { type: 'operation', id: 'session-a:call' });
  assert.deepEqual(page.rows.find(row => row.source === 'agent')!.reference, { type: 'agent', id: 'run-a' });
  assert.deepEqual(page.rows.find(row => row.source === 'external-agent')!.reference, { type: 'agent', id: 'external' });
  assert.match(renderLocalInbox(page), /operation_state \{\}/);
  assert.match(renderLocalInbox(page), /zoom \{"agent":"run-a"\}/);
  assert.match(renderLocalInbox(page), /current-session/i);
  const output = JSON.stringify(page) + renderLocalInbox(page);
  for (const secret of ['secret-token', 'secret-credential', 'secret-task', 'secret-report', 'secret-evidence', 'secret-args', '\u001b']) assert.ok(!output.includes(secret), secret);
  assert.ok(!output.includes('other:call'));
});

test('stable pages, separate namespaces and scope-bound cursor', () => {
  const input = sources(); input.runs.push(run('session-a:call', 'session-a'));
  const all = projectLocalInbox(input, undefined, 100).rows;
  let cursor: string | undefined; const collected = [];
  do { const page = projectLocalInbox(input, cursor, 1); collected.push(...page.rows); cursor = page.nextCursor ?? undefined; } while (cursor);
  assert.deepEqual(collected, all);
  assert.equal(new Set(all.map(r => `${r.source}:${r.id}`)).size, all.length);
  assert.equal(all.find(r => r.source === 'operation')!.id, all.find(r => r.source === 'agent' && r.id === all.find(o => o.source === 'operation')!.id)!.id);
  assert.throws(() => projectLocalInbox({ ...input, runs: [...input.runs, input.runs[0]] }));
  const next = projectLocalInbox(input, undefined, 1).nextCursor!;
  assert.throws(() => projectLocalInbox({ ...input, profileId: 'profile-b' }, next));
  assert.throws(() => projectLocalInbox({ ...input, sessionId: 'session-b' }, next));
  for (const value of ['', 'garbage', 'e30']) assert.throws(() => projectLocalInbox(input, value));
  for (const value of [0, -1, 101, 1.5, NaN]) assert.throws(() => projectLocalInbox(input, undefined, value));
});

test('empty scope and operation evidence status are explicit', () => {
  const empty = projectLocalInbox({ profileId: 'p', sessionId: 's', approvals: [], operations: [], runs: [] });
  assert.match(renderLocalInbox(empty), /no local items/i);
  const page = projectLocalInbox({ profileId: 'p', sessionId: 's', approvals: [], runs: [], operations: [{ id: 's:1', status: 'reconciled', evidence: 'untrusted report' }] });
  assert.equal(page.rows[0].status, 'reconciled');
  assert.equal(page.rows[0].verification, 'not_verified');
  assert.ok(!renderLocalInbox(page).includes('untrusted report'));
  const unknownTool = projectLocalInbox({ profileId: 'p', sessionId: 's', approvals: [{ token: 'token', tool: 'secret-credential', summary: '', expires: 1 }], operations: [], runs: [] });
  assert.ok(!renderLocalInbox(unknownTool).includes('secret-credential'));
  const hostile = projectLocalInbox({ profileId: 'p', sessionId: 's', approvals: [], runs: [run('id\n\x1b[31msecret', 's')], operations: [] });
  assert.equal(hostile.rows[0].reference.type === 'agent' && hostile.rows[0].reference.id, 'id\n\x1b[31msecret');
  assert.ok(!renderLocalInbox(hostile).includes('\x1b'));
  assert.ok(renderLocalInbox(hostile).includes('id\\n\\u001b'));
  const hostileOperation = projectLocalInbox({ profileId: 'p', sessionId: 's', approvals: [], runs: [], operations: [{ id: 's:hello\n\x1b', status: 'started' }] });
  assert.ok(!renderLocalInbox(hostileOperation).includes('\x1b'));
  assert.ok(renderLocalInbox(hostileOperation).includes('s:hello\\n\\u001b'));
  assert.doesNotMatch(renderLocalInbox(hostileOperation), /operation_state \{"id"/);
  assert.throws(() => projectLocalInbox({ profileId: 'p', sessionId: 's', approvals: [], runs: [run('id', 's', 'injected\nstatus' as RunInfo['state'])], operations: [] }));
});
