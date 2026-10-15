import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Tool } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor, task, type Shared } from '../src/compactor.ts';
import { compaction, tooLong } from '../src/prompts.ts';
import { createHandoffSummarizer } from '../src/handoff.ts';
import type { RunInfo } from '../src/runs.ts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Memory, bytes, NODE } from '../src/memory.ts';
import { estimatedContextTokens, inputTokenBudget } from '../src/run-context.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

let sentReasoning: string | undefined;
let sentStep = '';
let sentRetry = '';
/** A fake model with a configurable first response and a fitting retry by default. */
async function attempts(first: number, { source = 'user: ' + 'a long message '.repeat(70), merge = false, accepted, first: text = 'x', retryText = 'x'.repeat(400), firstEnd, ends = 1,
  contextWindow = 100000, maxTokens = 1000, shared, stats, replies, persist = false }:
  { source?: string; merge?: boolean; accepted?: number; first?: string; retryText?: string; firstEnd?: 'length' | 'toolUse'; ends?: number;
    contextWindow?: number; maxTokens?: number; shared?: Shared; stats?: { calls: number; prefixes?: string[] }; replies?: string[]; persist?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-size-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  let calls = 0;
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    // Like Sonnet 5.5: thinking can't be turned off.
    models: [{ id: 'compactor', name: 'Synthetic compactor', reasoning: true, thinkingLevelMap: { off: null, minimal: null }, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens }],
    streamSimple(model, context, options) {
      sentReasoning = options?.reasoning;
      const request = context.messages.find(m => m.role === 'user')?.content;
      sentStep = Array.isArray(request) ? request.map(c => c.type === 'text' ? c.text : '').at(-1) ?? '' : request ?? '';
      const last = context.messages.at(-1);
      if (stats) { stats.calls = calls + 1; stats.prefixes?.push(JSON.stringify([shared, context.messages[0]])); }
      sentRetry = context.messages.length > 1 && last?.role === 'user' && typeof last.content === 'string' ? last.content : '';
      const stream = createAssistantMessageEventStream();
      const end = calls < ends ? firstEnd ?? 'stop' : 'stop';
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: (replies?.[calls] ?? (calls ? retryText : text.repeat(first))) },
        ...end === 'toolUse' ? [{ type: 'toolCall' as const, id: 'call-1', name: 'zoom', arguments: { id: 0 } }] : []], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: end, usage: emptyUsage() };
      calls++;
      queueMicrotask(() => { stream.push({ type: 'done', reason: end, message }); stream.end(); });
      return stream;
    },
  });
  try {
    const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }), undefined,
      accepted === undefined ? undefined : () => accepted, shared === undefined ? undefined : () => shared);
    if (persist) {
      const directory = join(dir, 'memory');
      let memory = new Memory(directory, compress, () => {});
      try {
        memory.append('user', source.replace(/^user: /, ''));
        await memory.settle(AbortSignal.timeout(2000), 'tree');
        const summary = memory.node({ l: 0, i: 0 })!.text, view = memory.render();
        assert.equal(memory.lastError, undefined);
        assert.ok(memory.size >= bytes(summary), 'the view budgets actual bytes including the near miss');
        await memory.close();
        memory = new Memory(directory, async () => { throw new Error('saved nodes must not be rebuilt'); }, () => {});
        await memory.settle(AbortSignal.timeout(2000), 'tree');
        assert.equal(memory.render(), view, 'restart keeps the exact saved view for prefix caching');
        assert.equal(memory.zoom(0, 1), `0+1|${source}`, 'the exact original remains zoomable');
        return { calls, bytes: bytes(memory.node({ l: 0, i: 0 })!.text) };
      } finally { await memory.close(); }
    }
    const line = await compress({ context: '<chat>\n</chat>', source, part: merge ? { l: 1, i: 0 } : { l: 0, i: 0 } }, new AbortController().signal);
    return { calls, bytes: bytes(line) };
  } finally { removeDir(dir); }
}

function compactorMessages(source: string, shared: Shared): AgentMessage[] {
  const context = '<chat>\n</chat>', part = { l: 0, i: 0 };
  const step = task({ source, part }, 448);
  return [
    { role: 'system', content: shared.systemPrompt, toolsAdded: shared.tools, timestamp: 0 },
    { role: 'user', content: [{ type: 'text', text: context }, { type: 'text', text: `\n\n${step}` }], timestamp: 0 },
  ];
}
function contextWindow(maxTokens: number, fitting: number[], overflowing: number) {
  for (let window = maxTokens + 1; window < 100_000; window++) {
    const budget = inputTokenBudget(window, maxTokens);
    if (fitting.every(tokens => tokens <= budget) && overflowing > budget) return window;
  }
  throw new Error('Could not find a context window separating fitting and overflowing compactor requests.');
}

test('the compactor rejects combined shared prompt and tool-schema overflow before calling the provider', async () => {
  const shared: Shared = {
    systemPrompt: `System guidance: ${'preserve source details. '.repeat(120)}`,
    tools: [{ name: 'lookup', description: `Tool schema guidance: ${'query the indexed records carefully. '.repeat(120)}`,
      parameters: { type: 'object', properties: { query: { type: 'string' } } } } as Tool],
  };
  const source = 'user: ' + 'a long message '.repeat(70), request = compactorMessages(source, shared);
  const withoutTools = estimatedContextTokens(request.map(message => message.role === 'system' ? { ...message, toolsAdded: undefined } : message));
  const withoutPrompt = estimatedContextTokens(request.map(message => message.role === 'system' ? { ...message, content: '' } : message));
  const fullRequest = estimatedContextTokens(request), maxTokens = 128;
  const window = contextWindow(maxTokens, [withoutTools, withoutPrompt], fullRequest);
  const budget = inputTokenBudget(window, maxTokens);
  assert.ok(withoutTools <= budget && withoutPrompt <= budget, 'either shared component alone would fit');
  assert.ok(fullRequest > budget, 'the complete prompt, active tools, and user message exceed the input budget');

  const stats = { calls: 0 };
  await assert.rejects(attempts(1, { source, contextWindow: window, maxTokens, shared, stats }), /context is too large/);
  assert.equal(stats.calls, 0, 'an oversized request is rejected before streamSimple');
});

test('the compactor checks correction retries after prior summaries accumulate', async () => {
  const shared: Shared = { systemPrompt: 'Summarize the source precisely.', tools: [] };
  const source = 'user: ' + 'source detail '.repeat(150);
  const initial = compactorMessages(source, shared);
  const summary = 'user: ' + 'summary detail '.repeat(50);
  const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: summary }], api: 'openai-completions',
    provider: 'optchat-test', model: 'compactor', timestamp: 0, stopReason: 'stop', usage: emptyUsage() };
  const cut = Buffer.from(summary).subarray(0, NODE).toString('utf8').replace(/\uFFFD$/, '');
  const correction: AgentMessage = { role: 'user', content: tooLong(bytes(summary), cut, NODE, bytes(source)), timestamp: 0 };
  const firstTokens = estimatedContextTokens(initial), correctionTokens = estimatedContextTokens([...initial, reply, correction]);
  assert.ok(correctionTokens > firstTokens);
  const maxTokens = 512, window = contextWindow(maxTokens, [firstTokens], correctionTokens);
  assert.ok(inputTokenBudget(window, maxTokens) >= firstTokens, 'the initial request fits with the model output reserve');
  assert.ok(inputTokenBudget(window, maxTokens) < correctionTokens, 'the accumulated correction request exceeds that same budget');

  const stats = { calls: 0 };
  await assert.rejects(attempts(1, { source, first: summary, contextWindow: window, maxTokens, shared, stats }), /context is too large/);
  assert.equal(stats.calls, 1, 'only the fitting initial request reaches streamSimple');
});

test('by default a line over 512 bytes is retried, as in the recipe; a raised tolerance keeps one up to it', async () => {
  assert.deepEqual(await attempts(512), { calls: 1, bytes: 512 });
  assert.deepEqual(await attempts(513), { calls: 2, bytes: 400 });
  assert.deepEqual(await attempts(640, { accepted: 640 }), { calls: 1, bytes: 640 });
  assert.deepEqual(await attempts(641, { accepted: 640 }), { calls: 2, bytes: 400 });
});

test('after five over-limit replies, the shortest invalid summary is rejected', async () => {
  await assert.rejects(
    attempts(800, { source: 'x'.repeat(600), accepted: 512, retryText: 'y'.repeat(800) }),
    /no acceptable summary in 5 attempts.*512 bytes.*smaller than the source/,
  );
});

test('a reply cut off at the token limit, or one that calls a tool, is no summary: it is asked again', async () => {
  assert.deepEqual(await attempts(100, { firstEnd: 'length' }), { calls: 2, bytes: 400 }, 'a short line cut off by stopReason length');
  assert.deepEqual(await attempts(100, { firstEnd: 'toolUse' }), { calls: 2, bytes: 400 }, 'a short line beside a tool call');
  await assert.rejects(attempts(100, { firstEnd: 'length', ends: 5 }), /^Error: Compactor returned no whole line in 5 tries\.$/);
});

test('the profile\'s summary size tolerance decides when a line is retried', async () => {
  assert.deepEqual(await attempts(513, { accepted: 512 }), { calls: 2, bytes: 400 }, '512 is Victor\'s strict rule');
  assert.deepEqual(await attempts(700, { accepted: 700 }), { calls: 1, bytes: 700 });
});

test('a thinking level the model can\'t take is clamped like Pi does, not sent as none (which Sonnet 5.5 runs at high effort)', async () => {
  await attempts(400);
  assert.equal(sentReasoning, 'low', 'the fixture asks for "off"');
});

test('a merge that is not smaller than the two lines it replaces is retried', async () => {
  const children = ['a'.repeat(280), 'b'.repeat(280)].join('\n'); // 561 bytes
  assert.deepEqual(await attempts(590, { source: children, merge: true, accepted: 640 }), { calls: 2, bytes: 400 });
  assert.deepEqual(await attempts(590, { source: 'c'.repeat(1000), merge: true, accepted: 640 }), { calls: 1, bytes: 590 });
});

test('the task is the recipe\'s, with a 512-dash ruler for the size, and a merge names its lines and messages', () => {
  const ruler = '-'.repeat(NODE);
  assert.equal(task({ source: 'user: hi', part: { l: 0, i: 40 } }),
    `Compaction: compress message 40, kind user, into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${ruler}\n`
    + 'Summarize <input> alone, starting with "user:": the <chat> lines are other messages, never copy them in.\n<input>\nuser: hi\n</input>');
  assert.ok(task({ source: 'tool: bash {}', part: { l: 0, i: 41 }, result: 'bash: ok' })
    .endsWith('</input>\nThe call\'s result is in <result>: say in a few words what it found or did.\n<result>\nbash: ok\n</result>'));
  const merge = `Compaction: merge lines 40+4 and 44+4, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${ruler}\n`
    + `<chat> may hold their messages, 40 to 47, in more detail: take details\nof them from there too.\n<input>\na\nb\n</input>`;
  assert.equal(task({ source: 'a\nb', part: { l: 3, i: 5 } }), merge);
  assert.equal(compaction({ source: 'user: hi', part: { l: 0, i: 40 } }),
    `Compaction: compress message 40 into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${ruler}\n<input>\nuser: hi\n</input>`);
  assert.equal(compaction({ source: 'a\nb', part: { l: 3, i: 5 } }), merge);
});

test('a line over the limit is sent back with the recipe\'s "Too long" cut, and an id+n| head copied from the view is dropped', async () => {
  const source = 'user: ' + 'a long message '.repeat(70);
  assert.deepEqual(await attempts(700, { source }), { calls: 2, bytes: 400 });
  assert.ok(sentStep.startsWith('\n\nCompaction:'), 'the task starts its own paragraph: OpenAI joins text blocks with nothing between them');
  assert.ok(sentStep.endsWith(`<input>\n${source}\n</input>`));
  assert.equal(sentRetry, tooLong(700, 'x'.repeat(NODE), NODE, bytes(source)));
  assert.deepEqual(await attempts(1, { first: '12+4|user: kept' }), { calls: 1, bytes: 'user: kept'.length });
});


test('near misses retain the shortest complete shrinking summary after five tries, without changing the cached prefix', async () => {
  const stats = { calls: 0, prefixes: [] as string[] };
  assert.deepEqual(await attempts(0, { source: 's'.repeat(893), replies: [781, 739, 605, 546, 516].map(n => 'x'.repeat(n)), stats }),
    { calls: 5, bytes: 516 });
  assert.equal(new Set(stats.prefixes).size, 1, 'corrections append after the identical system/tools/view/task prefix');
  assert.deepEqual(await attempts(0, { replies: [520, 540, 530, 540, 540].map(n => 'x'.repeat(n)) }), { calls: 5, bytes: 520 });
});

test('near-miss fallback is bounded and must still shrink the source', async () => {
  assert.deepEqual(await attempts(544, { retryText: 'x'.repeat(544) }), { calls: 5, bytes: 544 });
  await assert.rejects(attempts(545, { retryText: 'x'.repeat(545) }), /no acceptable summary/);
  await assert.rejects(attempts(520, { source: 's'.repeat(520), retryText: 'x'.repeat(520) }), /no acceptable summary/);
  await assert.rejects(attempts(520, { firstEnd: 'length', ends: 5, retryText: 'x'.repeat(520) }), /no whole line/);
  await assert.rejects(attempts(520, { firstEnd: 'toolUse', ends: 5, retryText: 'x'.repeat(520) }), /no whole line/);
  assert.deepEqual(await attempts(0, { replies: ['é'.repeat(260), 'é'.repeat(263), 'é'.repeat(264), 'é'.repeat(265), 'é'.repeat(266)] }),
    { calls: 5, bytes: 520 }, 'measure UTF-8 bytes, not characters');
});

test('corrections state the real source-bound limit and a safety margin in UTF-8 bytes', async () => {
  await attempts(590, { source: 's'.repeat(561), accepted: 640, retryText: 'x'.repeat(400) });
  assert.match(sentRetry, /560-byte limit/);
  assert.match(sentRetry, /source is 561 bytes/);
  assert.match(sentRetry, /Aim for at most 490 UTF-8 bytes/);
  assert.match(sentStep, /Aim for at most 448 UTF-8 bytes/);
});


test('a near miss is durably saved once, budgets actual bytes and preserves original zoom and view after restart', async () => {
  const line = 'user: ' + 'x'.repeat(510);
  assert.deepEqual(await attempts(0, { source: 'user: ' + 's'.repeat(887), replies: Array(5).fill(line), persist: true }),
    { calls: 5, bytes: 516 });
});

test('handoffs clamp the compactor\'s thinking level too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-size-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  let sent: string | undefined;
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'compactor', name: 'Synthetic compactor', reasoning: true, thinkingLevelMap: { off: null, minimal: null }, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, _context, options) {
      sent = options?.reasoning;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Handoff.' }], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  try {
    const summarize = createHandoffSummarizer(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }), () => {});
    const run: RunInfo = { id: 'a1', task: 'Task', cwd: dir, model: 'optchat-test/compactor', thinking: 'off', parentSession: 'main', started: 0, depth: 1, state: 'completed', guidance: [] };
    assert.equal(await summarize(run, []), 'Handoff.');
    assert.equal(sent, 'low', 'the fixture asks for "off"');
  } finally { removeDir(dir); }
});
