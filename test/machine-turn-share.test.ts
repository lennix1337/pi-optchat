import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTrigger, tallySession } from '../src/machine-turn-share.ts';

test('classifies user and custom messages, with heartbeat before machine type', () => {
  for (const text of ['[gitwatch] PR', '[optchat-reload-resume] go', '[shell 1] done', '[OptChat claim check] hi']) {
    assert.equal(classifyTrigger({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }), 'machine');
  }
  assert.equal(classifyTrigger({ type: 'custom_message', customType: 'optchat-report', content: '[OptChat heartbeat] hi' }), 'heartbeat');
  assert.equal(classifyTrigger({ type: 'custom_message', customType: 'gitwatch', content: 'hi' }), 'machine');
  assert.equal(classifyTrigger({ type: 'custom_message', customType: 'optchat-report', content: 'hi' }), 'machine');
  assert.equal(classifyTrigger({ type: 'message', message: { role: 'user', content: '[Slack] hello' } }), 'human');
  assert.equal(classifyTrigger({ type: 'message', message: { role: 'system', content: 'setup' } }), 'unknown');
});

test('tallies JSONL within the window by model, trigger and cut; tool results do not reset trigger', () => {
  const events = [
    { type: 'message', message: { role: 'user', content: 'hello' } },
    { type: 'message', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', model: 'claude-opus-5' } },
    { type: 'custom_message', customType: 'gitwatch', content: 'event' },
    { type: 'message', message: { role: 'toolResult' } },
    { type: 'message', timestamp: '2026-01-01T01:00:00Z', message: { role: 'assistant', model: 'claude-opus-5' } },
    { type: 'message', timestamp: '2026-01-01T02:00:00Z', message: { role: 'assistant', model: 'claude-opus-5' } },
    { type: 'custom_message', customType: 'optchat-report', content: '[OptChat heartbeat] wake' },
    { type: 'message', timestamp: '2026-01-01T03:00:00Z', message: { role: 'assistant', model: 'other' } },
    { type: 'message', message: { role: 'system', content: 'system' } },
    { type: 'message', timestamp: '2026-01-01T04:00:00Z', message: { role: 'assistant', model: 'other' } },
  ];
  const result = tallySession(events.map(e => JSON.stringify(e)).join('\n'), Date.parse('2026-01-01T00:30:00Z'), Date.parse('2026-01-01T02:00:00Z'), Date.parse('2026-01-01T04:00:00Z'));
  assert.deepEqual(result.models.get('claude-opus-5'), { human: 0, machine: 2, heartbeat: 0, unknown: 0 });
  assert.deepEqual(result.models.get('other'), { human: 0, machine: 0, heartbeat: 1, unknown: 1 });
  assert.deepEqual(result.opusBefore, { total: 1, machine: 1 });
  assert.deepEqual(result.opusAfter, { total: 1, machine: 1 });
});
