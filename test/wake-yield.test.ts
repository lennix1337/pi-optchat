import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { wakeYield } from '../src/wake-yield.ts';

const event = (timestamp: string, body: object) => JSON.stringify({ timestamp, ...body });
const heartbeat = (time: string) => event(time, { type: 'custom_message', content: '[OptChat heartbeat] check' });
const assistant = (time: string, model: string, content: object[] = []) => event(time, { type: 'message', message: { role: 'assistant', model, content } });
const at = (minute: string) => `2026-01-01T12:${minute}:00Z`;

test('splits wakes at heartbeats and real human messages, and counts deliveries', () => {
  const jsonl = [
    heartbeat(at('00')),
    assistant(at('01'), 'model-a', [{ type: 'toolCall', name: 'bash', arguments: { command: 'node scripts/ship.mjs -m fix' } }]),
    heartbeat(at('02')),
    assistant(at('03'), 'model-b'),
    heartbeat(at('04')),
    assistant(at('05'), 'model-a'),
    event(at('06'), { type: 'message', message: { role: 'user', content: 'hello' } }),
    assistant(at('07'), 'model-c', [{ type: 'toolCall', name: 'spawn', arguments: {} }]),
  ].join('\n');
  const result = wakeYield(jsonl, Date.parse(at('00')), Date.parse(at('59')));
  assert.deepEqual(result.wakes.map(w => [w.start, w.messages, w.models, w.delivered]), [
    [at('00'), 1, ['model-a'], true], [at('02'), 1, ['model-b'], false], [at('04'), 1, ['model-a'], false],
  ]);
  assert.deepEqual(result.summary, { wakes: 3, delivered: 1, without: 2, messagesWithout: 2, messages: 3 });
});

test('recognizes crew actions and applies the window to wake start', () => {
  const jsonl = [heartbeat(at('00')), assistant(at('01'), 'a'), heartbeat(at('02')),
    assistant(at('03'), 'b', [{ type: 'toolCall', name: 'crew', arguments: { action: 'accept' } }]),
    heartbeat(at('04')), assistant(at('05'), 'b', [{ type: 'toolCall', name: 'crew', arguments: { action: 'spawn' } }]),
    heartbeat(at('06')), assistant(at('07'), 'b', [{ type: 'toolCall', name: 'spawn', arguments: {} }]),
    heartbeat(at('08')), assistant(at('09'), 'b', [{ type: 'toolCall', name: 'crew', arguments: { action: 'status' } }]),
  ].join('\n');
  const { wakes } = wakeYield(jsonl, Date.parse(at('02')), Date.parse(at('09')));
  assert.deepEqual(wakes.map(w => w.delivered), [true, true, true, false]);
});
