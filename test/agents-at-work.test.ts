import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { atWork, buildContext } from '../src/transcript.ts';
import { cachePayload, isAtWork } from '../src/cache.ts';
import { PROMPT } from '../src/recipe-prompt.ts';

const user: AgentMessage = { role: 'user', content: 'question', timestamp: 0 };
const view = '<chat>\n' + '0+1|line\n'.repeat(400) + '</chat>';

test('the status line names running agents by id and first task words, under a label the main prompt explains', () => {
  assert.equal(atWork([{ id: 'a1', task: 'Review PR #123 "carefully"\nthen report back to me' }, { id: 'b2', task: 'Fix it' }]),
    '[OptChat status] Agents at work now: a1 "Review PR #123 \'carefully\' then report…", b2 "Fix it".');
  assert.equal(atWork([{ id: 'c3', task: 'x'.repeat(5_000) }]), `[OptChat status] Agents at work now: c3 "${'x'.repeat(60)}…".`, 'a long word is cut too');
  assert.match(PROMPT, /"\[OptChat status\]" is OptChat's own note/);
  assert.match(PROMPT, /agents and shells are running, not the user/, 'the prompt names shells in the status note');
});

test('with no agents running there is no status line at all', () => {
  assert.equal(atWork([]), undefined);
  assert.deepEqual(buildContext([user], [user], view, 'prompt', [], atWork([])).map(m => m.role), ['system', 'user']);
});

test('a call that follows a tool result carries no status line: the turn already has it', () => {
  const line = atWork([{ id: 'a1', task: 'Fix it' }])!;
  const call: AgentMessage = { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'date', arguments: { id: 0 } }], api: 'anthropic-messages', provider: 'p', model: 'm',
    stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 };
  const result: AgentMessage = { role: 'toolResult', toolCallId: 't', toolName: 'date', content: [{ type: 'text', text: 'Fri' }], isError: false, timestamp: 0 };
  assert.deepEqual(buildContext([user, call, result], [user, call, result], view, 'prompt', [], undefined, line).map(m => m.role), ['system', 'user', 'assistant', 'toolResult']);
});

test('the status line goes last, and the turn\'s cache mark sits on the block before it', () => {
  const line = atWork([{ id: 'a1', task: 'Fix it' }])!;
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
  assert.equal(atWork([], [{ id: 'sh1', command: 'npm run build -- --watch' }]), '[OptChat status] Shells running now: sh1 "npm run build -- --watch".');
  assert.equal(atWork([{ id: 'a1', task: 'Fix it' }], [{ id: 'sh1', command: 'node server.js' }]),
    '[OptChat status] Agents at work now: a1 "Fix it". Shells running now: sh1 "node server.js".');
  assert.equal(atWork([], []), undefined, 'nothing running, no line');
  const line = atWork([], [{ id: 'sh1', command: 'node server.js' }])!;
  assert.equal(isAtWork({ role: 'user', content: [{ type: 'text', text: line }] }), true, 'cache marks skip it like the agents line');
});
