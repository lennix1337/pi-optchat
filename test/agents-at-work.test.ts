import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { atWork, buildContext } from '../src/transcript.ts';
import { boardView, type BoardRun, type BoardShell } from '../src/waiting-board.ts';
import { cachePayload, isAtWork } from '../src/cache.ts';
import { PROMPT } from '../src/recipe-prompt.ts';
import { MASTER } from '../src/prompts.ts';

const user: AgentMessage = { role: 'user', content: 'question', timestamp: 0 };
const NOW = Date.parse('2026-11-11T16:49:00Z');
const board = (runs: Partial<BoardRun>[] = [], shells: Partial<BoardShell>[] = []) => boardView({ now: NOW,
  runs: runs.map(r => ({ id: 'a1', task: 'Fix it', model: 'p/m', state: 'running' as const, started: NOW - 60_000, ...r })),
  shells: shells.map(j => ({ id: 'sh1', command: 'node server.js', state: 'running' as const, started: NOW - 60_000, ...j })) });
const view = '<chat>\n' + '0+1|line\n'.repeat(400) + '</chat>';

test('the status line is the waiting board: running agents by id, first task words, elapsed time and progress, under a label the main prompt explains', () => {
  assert.equal(atWork(board([{ id: 'a1', task: 'Goal: Review PR #123 "carefully"\nthen report back to me', cwd: 'C:/projetos/pi-optchat', phase: 'lendo código' }])),
    '[OptChat status] 13:49 pendente:\n- pi-optchat · Review PR #123 "carefully" · lendo código · 1m · m [a1]');
  assert.match(atWork(board([{ task: 'x'.repeat(5_000) }]))!, new RegExp(`${'x'.repeat(43)}… · 1m`), 'a long word is cut too');
  assert.match(PROMPT, /"\[OptChat status\]" is OptChat's own live note/);
  assert.match(PROMPT, /what is pending \(agents, shells, CI, what waits on the user\)/, 'the prompt says what the status note holds');
  assert.match(MASTER, /what is pending \(agents, shells, CI, what waits on the user\)/, 'the master prompt says it too');
  assert.match(MASTER, /don't run gh, crew list or shell_status just to learn it/);
});

test('with no agents running there is no status line at all', () => {
  assert.equal(atWork(board()), undefined);
  assert.equal(atWork(undefined), undefined);
  assert.deepEqual(buildContext([user], [user], view, 'prompt', [], atWork(board())).map(m => m.role), ['system', 'user']);
});

test('a call that follows a tool result carries no status line: the turn already has it', () => {
  const line = atWork(board([{}]))!;
  const call: AgentMessage = { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'date', arguments: { id: 0 } }], api: 'anthropic-messages', provider: 'p', model: 'm',
    stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 };
  const result: AgentMessage = { role: 'toolResult', toolCallId: 't', toolName: 'date', content: [{ type: 'text', text: 'Fri' }], isError: false, timestamp: 0 };
  assert.deepEqual(buildContext([user, call, result], [user, call, result], view, 'prompt', [], undefined, line).map(m => m.role), ['system', 'user', 'assistant', 'toolResult']);
});

test('the status line goes last, and the turn\'s cache mark sits on the block before it', () => {
  const line = atWork(board([{}]))!;
  assert.deepEqual(buildContext([user], [user], view, 'prompt', [], undefined, line).at(-1), { role: 'user', content: [{ type: 'text', text: line }], timestamp: 0 });
  // As Anthropic receives it, right after a tool result: the line changes between calls, so a mark on it would be written and never read.
  const payload = { messages: [
    { role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: 'question' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: line }] },
    // Pi ends Anthropic requests with an empty system message carrying settings such as effort.
    { role: 'system', content: [], output_config: { effort: 'low' } },
  ] };
  const output = cachePayload(payload) as typeof payload & { cache_control?: unknown };
  assert.equal(output.cache_control, undefined);
  assert.deepEqual(output.messages[2].content[0], { type: 'tool_result', tool_use_id: 't', content: 'ok', cache_control: { type: 'ephemeral' } });
  assert.ok(!('cache_control' in output.messages[3].content[0]));
  assert.equal((JSON.stringify(output).match(/cache_control/g) ?? []).length, 4, 'three view marks and the turn: Anthropic\'s limit');
});

test('the status line also names running background shells, alone or with agents; a shell-only line is still recognised as the status line', () => {
  assert.equal(atWork(board([], [{ id: 'sh1xxxxxxxx', command: 'npm run build -- --watch', last: 'built in 3s' }])), '[OptChat status] 13:49 pendente:\n- shell npm run build -- --watch · 1m · built in 3s [sh1xxxxx]');
  assert.equal(atWork(board([{}], [{}])), '[OptChat status] 13:49 pendente:\n- Fix it · 1m · m [a1]\n- shell node server.js · 1m [sh1]');
  assert.equal(atWork(board([], [])), undefined, 'nothing running, no line');
  const line = atWork(board([], [{}]))!;
  assert.equal(isAtWork({ role: 'user', content: [{ type: 'text', text: line }] }), true, 'cache marks skip it like the agents line');
});
