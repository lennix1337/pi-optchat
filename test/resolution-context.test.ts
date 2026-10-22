import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { budgetContext, buildContext, refreshedRun } from '../src/transcript.ts';
import { estimatedContextTokens } from '../src/run-context.ts';
import { Memory, type Part } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { TURN_REFRESHED } from '../src/prompts.ts';
import { userTexts } from './messages.ts';

const task: AgentMessage = { role: 'user', content: 'Resume the old project. Do not publish.', timestamp: 1 };
const view = '<chat>\n0+1|Earlier project decision; exact evidence in original.\n</chat>';
const focus = '<focus>\n0+1|user: Scope is disposable KBs only.\n</focus>';
const empty = { node: () => undefined } as unknown as Memory;
const userText = (messages: AgentMessage[]) => userTexts(messages).join('\n');

test('focus is after the unchanged chronological prefix, before state and the live request', () => {
  const messages = buildContext([], [task], view, 'system', [], 'state', undefined, focus);
  const message = messages[1];
  assert.ok(message.role === 'user' && Array.isArray(message.content));
  assert.deepEqual(message.content.map(b => b.type === 'text' ? b.text : ''), [view, `\n\n${focus}`, '\n\nstate', `\n\n${task.content}`]);
  const changed = buildContext([], [task], view, 'system', [], 'state', undefined, focus.replace('KBs', 'fixtures'));
  assert.deepEqual(messages[0], changed[0]);
  assert.deepEqual(message.content[0], changed[1].role === 'user' && Array.isArray(changed[1].content) ? changed[1].content[0] : undefined);
  assert.equal(task.content, 'Resume the old project. Do not publish.');
});

test('focus counts toward the full budget and is shed before chronological coarsening', () => {
  let reads = 0;
  const memory = { node: (_part: Part) => { reads++; return undefined; } } as unknown as Memory;
  const plain = buildContext([], [task], view, 'system');
  const allowance = estimatedContextTokens(plain);
  const withRoom = budgetContext(memory, [], [task], view, 'system', allowance + 500, [], undefined, undefined, focus);
  assert.ok(userText(withRoom.messages).includes(focus));
  assert.ok(withRoom.tokens > allowance);
  const fitted = budgetContext(memory, [], [task], view, 'system', allowance, [], undefined, undefined, focus);
  assert.equal(fitted.fits, true);
  assert.deepEqual(fitted.messages, plain);
  assert.equal(reads, 0, 'expendable detail must not force any tree merging');
});

test('overflow after dropping focus still fails closed rather than trimming current instructions', () => {
  const fitted = budgetContext(empty, [], [task], view, 'system', 1, [], 'private state', 'job active', focus);
  assert.equal(fitted.fits, false);
  assert.ok(userText(fitted.messages).includes(String(task.content)));
  assert.ok(userText(fitted.messages).includes('private state'));
  assert.ok(userText(fitted.messages).includes('job active'));
  assert.ok(!userText(fitted.messages).includes('<focus>'));
});

test('focus survives refresh assembly without orphaning tool results or replacing current corrections', () => {
  const step = (id: string): AgentMessage[] => [
    { role: 'assistant', content: [{ type: 'toolCall', id, name: 'zoom', arguments: { id: 0 } }], timestamp: 2,
      api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', usage: emptyUsage() },
    { role: 'toolResult', toolCallId: id, toolName: 'zoom', content: [{ type: 'text', text: 'Old project original.' }], isError: false, timestamp: 3 },
  ];
  const correction: AgentMessage = { role: 'user', content: 'Correction: authorization revoked; analysis only.', timestamp: 4 };
  const run = [task, ...step('old'), correction, ...step('new')];
  const messages = buildContext([], refreshedRun(run, 4, TURN_REFRESHED), view, 'system', [], undefined, undefined, focus);
  assert.ok(userText(messages).includes(focus));
  assert.ok(userText(messages).includes(String(correction.content)));
  assert.equal(messages.filter(m => m.role === 'assistant').length, 1);
  assert.ok(messages.some(m => m.role === 'toolResult' && m.toolCallId === 'new'));
  assert.equal(messages.some(m => m.role === 'toolResult' && m.toolCallId === 'old'), false);
});
