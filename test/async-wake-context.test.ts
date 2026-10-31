import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { asUser, buildContext, refreshedRun, textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

const view = '<chat>\n0+1|user: Implement locally; do not publish.\n</chat>';
const notice: AgentMessage = { role: 'custom', customType: 'subagent-notify', display: false,
  content: 'Workflow completed; saved reports are ready for review.', timestamp: 2 };

test('a hidden native completion is valid current input, without becoming a user instruction', () => {
  assert.equal(asUser(notice), notice, 'display and provenance remain unchanged');
  const messages = buildContext([], [notice], view, 'system');
  const input = messages[1];
  assert.equal(input.role, 'custom');
  assert.ok(input.role === 'custom' && input.customType === 'subagent-notify' && input.display === false);
  assert.ok(textContent(input.content).startsWith(view));
  assert.ok(textContent(input.content).includes('Extension event (subagent-notify), not a new user instruction or authorization:'));
  assert.ok(textContent(input.content).endsWith(String(notice.content)));
  assert.equal(notice.content, 'Workflow completed; saved reports are ready for review.');
  assert.equal(messages.some(message => message.role === 'user'), false, 'no fabricated user request');
});

test('hidden completion plus tool continuation keeps the starting notice across refresh', () => {
  const call: AgentMessage = { role: 'assistant', content: [{ type: 'toolCall', id: 'inspect', name: 'read', arguments: {} }],
    api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', usage: emptyUsage(), timestamp: 3 };
  const result: AgentMessage = { role: 'toolResult', toolCallId: 'inspect', toolName: 'read',
    content: [{ type: 'text', text: 'Saved report.' }], isError: false, timestamp: 4 };
  const messages = buildContext([], refreshedRun([notice, call, result], 1, 'Refreshed.'), view, 'system');
  assert.ok(messages.some(message => message.role === 'custom' && textContent(message.content).includes(String(notice.content))));
  assert.deepEqual(messages.slice(-2), [call, result]);
});

test('hidden per-turn context does not displace a real current user message', () => {
  const user: AgentMessage = { role: 'user', content: 'New instruction.', timestamp: 3 };
  const messages = buildContext([], [notice, user], view, 'system');
  assert.deepEqual(messages[1], notice);
  assert.ok(messages[2].role === 'user' && textContent(messages[2].content).startsWith(view));
});

test('a hidden completion keeps its provenance when the previous exchange holds the view', () => {
  const previous: Extract<AgentMessage, { role: 'user' }>[] = [{ role: 'user', content: 'Earlier authorized task.', timestamp: 1 }];
  const messages = buildContext([], [notice], view, 'system', previous);
  assert.ok(messages[1].role === 'user' && textContent(messages[1].content).startsWith(view));
  const wake = messages[2];
  assert.ok(wake.role === 'custom' && wake.customType === notice.customType && wake.display === false);
  assert.match(textContent(wake.content), /Extension event \(subagent-notify\), not a new user instruction or authorization:/);
  assert.ok(textContent(wake.content).endsWith(String(notice.content)));
  assert.equal(previous[0].content, 'Earlier authorized task.');
  assert.equal(notice.content, 'Workflow completed; saved reports are ready for review.');
  assert.equal(messages.filter(message => message.role === 'user').length, 1, 'only the existing user message remains');
});

test('a shown message arriving mid-run keeps the wake run\'s request prefix, so the prompt cache still holds', () => {
  // Session 01a1878b, 2026-10-30 18:50: a goal continuation (hidden) ran tool calls, a shell report arrived, and the next
  // request rewrote 173,795 cached tokens because the view moved from the wake to the report and the wake lost its label.
  const call: AgentMessage = { role: 'assistant', content: [{ type: 'toolCall', id: 'inspect', name: 'read', arguments: {} }],
    api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', usage: emptyUsage(), timestamp: 3 };
  const result: AgentMessage = { role: 'toolResult', toolCallId: 'inspect', toolName: 'read',
    content: [{ type: 'text', text: 'Saved report.' }], isError: false, timestamp: 4 };
  const report = asUser({ role: 'custom', customType: 'optchat-report', display: true, content: '[shell 1] completed', timestamp: 5 });
  const before = buildContext([], [notice, call, result], view, 'system');
  const after = buildContext([], [notice, call, result, report], view, 'system');
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.at(-1), report);
});

test('no current input still refuses historical-only replay', () => {
  const old: AgentMessage = { role: 'user', content: 'Old task is not a current wake.', timestamp: 1 };
  assert.throws(() => buildContext([old], [], view, 'system', [old]), /no current .*message/);
});
