import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model, Tool } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { StableHead } from '../src/stable-head.ts';
import { cachePayload } from '../src/cache.ts';

const tool = (name: string, description = name): Tool => ({ name, description, parameters: { type: 'object', properties: {} } as Tool['parameters'] });
const BASE = [tool('read'), tool('bash')], WEB = [...BASE, tool('web_search')];
const VIEW = '<chat>\n' + '0+1|summary of a decision\n'.repeat(400) + '</chat>';
const OLD = '<instructions>\nold rules\n</instructions>', NEW = '<instructions>\nnew rules\n</instructions>';
const PROMPT = (instructions = OLD) => `You are OptChat.\n\n${instructions}`;
const anchor: AgentMessage = { role: 'user', content: [{ type: 'text', text: VIEW }, { type: 'text', text: '\n\nquestion' }], timestamp: 1 };
const call = (id: string, at: number): AgentMessage[] => [
  { role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: {} }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-opus-5-5',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: at },
  { role: 'toolResult', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text: `output ${id}` }], isError: false, timestamp: at + 1 },
];
const built = (tools: Tool[], run: AgentMessage[], prompt = PROMPT()): AgentMessage[] =>
  [{ role: 'system', content: prompt, toolsAdded: tools, timestamp: 0 }, anchor, ...run];
const model = { id: 'claude-opus-5-5', name: 'Opus', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://invalid.local', reasoning: false,
  input: ['text'], contextWindow: 1_000_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } } as Model<'anthropic-messages'>;
const options = (epoch: number, more: Partial<Parameters<StableHead['apply']>[1]> = {}) =>
  ({ model: 'anthropic/claude-opus-5-5', native: true, cold: false, epoch, sections: { instructions: OLD }, ...more });

/** Pi's own Anthropic request for these messages, cached the way OptChat does it; nothing leaves the process. */
async function wire(messages: AgentMessage[]) {
  let params: Record<string, unknown> | undefined;
  const events = stream(model, { messages } as never, { apiKey: 'sk-ant-offline', onPayload: (payload: unknown) => { params = structuredClone(payload) as Record<string, unknown>; throw new Error('offline'); } });
  for await (const _event of events) { /* drain until Pi reports the offline error */ }
  assert.ok(params, 'Pi built a request');
  const strip = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === 'cache_control' ? undefined : item));
  return { tools: strip(params.tools), system: strip(params.system), messages: strip(params.messages) as { role: string; content: unknown }[],
    cached: cachePayload(structuredClone(params), { prefix: 'long' }) as { messages: { content: unknown }[] } };
}

test('a tool enabled mid-turn leaves the request\'s tools and system prompt as they were and arrives as a native tool addition', async () => {
  const head = new StableHead();
  const first = head.apply(built(BASE, call('a', 2)), options(1));
  assert.deepEqual(first, built(BASE, call('a', 2)), 'the first request is sent as built');
  const second = head.apply(built(WEB, call('a', 2)), options(1));
  assert.deepEqual(second[0], built(BASE, [])[0], 'the head keeps the tools the cached prefix was written with');
  assert.equal(second.length, 5);
  assert.deepEqual(second.at(-1), { role: 'system', content: '', toolsAdded: [tool('web_search')], timestamp: 3 }, 'the new tool comes after the messages already sent');
  const [before, after] = [await wire(first), await wire(second)];
  assert.deepEqual(after.tools, before.tools, 'the top-level tool list is unchanged');
  assert.deepEqual(after.system, before.system);
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages, 'every message sent before is sent again unchanged');
  assert.match(JSON.stringify(after.messages), /"tool_addition".*"web_search"/);
  // The next step of the same turn: the addition keeps its place, so the last request is a prefix of this one.
  const third = head.apply(built(WEB, [...call('a', 2), ...call('b', 4)]), options(1));
  assert.deepEqual(third.slice(0, 5), second, 'the addition stays where it was first sent');
  const next = await wire(third);
  assert.deepEqual(next.messages.slice(0, after.messages.length), after.messages);
  // A new turn: the view grows anyway, so the change moves right after it and the head still holds.
  const turn = head.apply(built(WEB, [{ role: 'user', content: 'next question', timestamp: 10 }]), options(2));
  assert.deepEqual(turn[0], built(BASE, [])[0]);
  assert.deepEqual(turn[2], { role: 'system', content: '', toolsAdded: [tool('web_search')], timestamp: 1 }, 'after the message that holds the view');
  assert.deepEqual((await wire(turn)).tools, before.tools);
});

test('a tool withdrawn and a definition changed are native changes too; returning to the head\'s tools sends no change', () => {
  const head = new StableHead();
  head.apply(built(BASE, []), options(1));
  const changed = head.apply(built([tool('read', 'read v2')], []), options(2));
  assert.deepEqual(changed[2], { role: 'system', content: '', toolsAdded: [tool('read', 'read v2')], toolsRemoved: [{ name: 'read' }, { name: 'bash' }], timestamp: 1 });
  assert.deepEqual(head.apply(built(BASE, []), options(3)), built(BASE, []));
});

test('an edited instructions section is sent as Pi\'s section update; an edit no section explains rewrites the head', () => {
  const head = new StableHead();
  head.apply(built(BASE, []), options(1));
  const edited = head.apply(built(BASE, [], PROMPT(NEW)), options(2, { sections: { instructions: NEW } }));
  assert.equal(edited[0].role === 'system' && edited[0].content, PROMPT(), 'the head keeps the prompt its entry was written with');
  assert.deepEqual(edited[2], { role: 'system', content: '', sections: { instructions: NEW }, timestamp: 1 });
  const unexplained = built(BASE, [], 'A different preamble.\n\n' + NEW);
  assert.deepEqual(head.apply(unexplained, options(3, { sections: { instructions: NEW } })), unexplained, 'sent as built, and it becomes the new head');
  assert.deepEqual(head.apply(built(WEB, [], 'A different preamble.\n\n' + NEW), options(4, { sections: { instructions: NEW } }))[0],
    built(BASE, [], 'A different preamble.\n\n' + NEW)[0]);
});

test('a reload keeps the head its entry was written with: the saved base comes back and Pi\'s changes since go after the view', async () => {
  const before = new StableHead();
  const sent = before.apply(built(BASE, call('a', 2)), options(3));
  // What the session keeps across /reload is JSON.
  const saved = JSON.parse(JSON.stringify(before.saved()));
  const after = new StableHead();
  after.restore(saved);
  const reloaded = after.apply(built(WEB, [{ role: 'user', content: 'after reload', timestamp: 10 }], PROMPT(NEW)), options(0, { sections: { instructions: NEW } }));
  assert.deepEqual(reloaded[0], built(BASE, [])[0], 'the head the cache entry was written with, not the reloaded prompt');
  assert.deepEqual(reloaded[2], { role: 'system', content: '', sections: { instructions: NEW }, toolsAdded: [tool('web_search')], timestamp: 1 });
  const [old, now] = [await wire(sent), await wire(reloaded)];
  assert.deepEqual(now.tools, old.tools);
  assert.deepEqual(now.system, old.system);
  // Nothing saved (a session from before this, or a malformed entry): the first request rewrites the head as before.
  for (const nothing of [undefined, { prompt: 1 }]) {
    const fresh = new StableHead();
    fresh.restore(saved);
    fresh.restore(nothing);
    assert.equal(fresh.saved(), undefined);
    assert.deepEqual(fresh.apply(built(WEB, []), options(0)), built(WEB, []));
  }
});

test('the head is rewritten when its entry cannot be read anyway: cold cache, another model, or no native tool changes', () => {
  for (const later of [{ cold: true }, { model: 'anthropic/claude-fable-5-1' }, { native: false }]) {
    const head = new StableHead();
    head.apply(built(BASE, []), options(1));
    assert.deepEqual(head.apply(built(WEB, []), options(1, later)), built(WEB, []), JSON.stringify(later));
    if (!later.native) assert.deepEqual(head.apply(built(WEB, [], PROMPT()), options(2))[0], built(WEB, [])[0], 'the rewritten head is the new base');
  }
});
