import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyUsage } from '../src/usage.ts';
import { assistantMessage, customMessage, toolCallMessage, toolResultMessage, userMessage, userTexts } from './messages.ts';

test('the fixture message constructors keep the exact shapes the tests replaced', () => {
  assert.deepEqual(userMessage('Do it.'), { role: 'user', content: 'Do it.', timestamp: 1 });
  assert.deepEqual(userMessage('Do it.', 4), { role: 'user', content: 'Do it.', timestamp: 4 });
  const base = { role: 'assistant', timestamp: 2, api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: emptyUsage() };
  assert.deepEqual(assistantMessage([{ type: 'text', text: 'Done.' }]), { ...base, content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' });
  assert.deepEqual(toolCallMessage('a', 'read'), { ...base, content: [{ type: 'toolCall', id: 'a', name: 'read', arguments: {} }], stopReason: 'toolUse' });
  assert.deepEqual(toolResultMessage('a', 'read', 'out'), { role: 'toolResult', toolCallId: 'a', toolName: 'read', content: [{ type: 'text', text: 'out' }], isError: false, timestamp: 3 });
  assert.deepEqual(toolResultMessage('a', 'bash', 'out', { isError: true, timestamp: 1 }), { role: 'toolResult', toolCallId: 'a', toolName: 'bash', content: [{ type: 'text', text: 'out' }], isError: true, timestamp: 1 });
  assert.deepEqual(customMessage('note', 'shown'), { role: 'custom', customType: 'note', content: 'shown', display: true, timestamp: 1 });
  assert.deepEqual(customMessage('note', 'hidden', false), { role: 'custom', customType: 'note', content: 'hidden', display: false, timestamp: 1 });
});

test('userTexts keeps only user messages, in order, and flattens block content', () => {
  const messages = [userMessage('first'), assistantMessage([{ type: 'text', text: 'answer' }]), customMessage('note', 'custom'), toolResultMessage('a', 'read', 'out'),
    userMessage([{ type: 'text', text: 'second' }])];
  assert.deepEqual(userTexts(messages), ['first', 'second']);
});
