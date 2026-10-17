import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BenchmarkCacheTrace, summarizeCache, ResponseBudget } from './benchmark-cache.js';

test('response budget aborts once and disallows another request, without resetting on completion', async () => {
  let aborted = 0;
  const budget = new ResponseBudget(5, () => { aborted++; });
  budget.begin();
  await new Promise(resolve => setTimeout(resolve, 20));
  budget.complete();
  assert.equal(budget.exceeded, true);
  assert.equal(aborted, 1);
  assert.throws(() => budget.begin(), /exceeded/);
  budget.dispose();
});

test('completed or disposed responses cancel their deadline', async () => {
  let aborted = 0;
  const budget = new ResponseBudget(5, () => { aborted++; });
  budget.begin(); budget.complete();
  budget.begin(); budget.dispose();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(aborted, 0);
  assert.equal(budget.exceeded, false);
});

test('cache trace detects prefix/key changes without persisting content', () => {
  const trace = new BenchmarkCacheTrace();
  const secret = 'private tool result and cache key';
  trace.request({ instructions: secret, tools: [], prompt_cache_key: secret, input: [{ text: secret }] }, 10);
  trace.complete({ input: 1024, cacheRead: 0, output: 1 }, 30);
  trace.request({ instructions: secret, tools: [], prompt_cache_key: secret, input: [{ text: secret }, { text: 'new' }] }, 40);
  trace.complete({ input: 128, cacheRead: 1024, output: 2 }, 70);
  assert.equal(trace.requests[1].commonPrefixItems, 1);
  assert.equal(trace.requests[1].previousInputItems, 1);
  assert.equal(trace.requests[1].cacheKeyHash, trace.requests[0].cacheKeyHash);
  assert.equal(trace.requests[1].payloadToMessageEndMs, 30);
  assert.ok(!JSON.stringify(trace.requests).includes(secret));
  trace.request({ instructions: 'changed', input: [{ text: 'changed' }] });
  assert.equal(trace.requests[2].commonPrefixItems, 0);
  assert.equal(trace.requests[2].cacheKeyHash, null);
  assert.notEqual(trace.requests[2].instructionsHash, trace.requests[1].instructionsHash);
});

test('cache trace records first nonempty content delta, not stream start or private content', () => {
  const trace = new BenchmarkCacheTrace();
  trace.delta('text_delta', 'before request', 1);
  trace.request({ instructions: 'a', input: [] }, 10);
  trace.delta('start', 'ignored', 11);
  trace.delta('text_delta', '', 12);
  assert.equal(trace.requests[0].firstDeltaMs, undefined);
  trace.delta('thinking_delta', 'private reasoning', 25);
  trace.delta('text_delta', 'later text', 35);
  trace.complete({ input: 1, cacheRead: 0, output: 1 }, 50);
  assert.equal(trace.requests[0].firstDeltaMs, 15);
  assert.equal(trace.requests[0].firstDeltaKind, 'thinking_delta');
  assert.equal(trace.requests[0].payloadToMessageEndMs, 40);
  trace.request({ input: [] }, 60);
  trace.delta('toolcall_delta', '{"command":"private"}', 65);
  assert.equal(trace.requests[1].firstDeltaMs, 5);
  trace.complete({ input: 1, cacheRead: 0, output: 1 }, 70);
  trace.delta('text_delta', 'after completion', 80);
  assert.equal(trace.requests[1].firstDeltaKind, 'toolcall_delta');
  assert.ok(!JSON.stringify(trace.requests).includes('private'));
});

test('concurrent compactor replies retain request-specific timing and usage', () => {
  const trace = new BenchmarkCacheTrace();
  const first = trace.request({ input: ['first'] }, 10);
  const second = trace.request({ input: ['second'] }, 20);
  trace.delta('text_delta', 'first delta', 30, first);
  trace.complete({ input: 100, cacheRead: 50, output: 10 }, 40, first);
  trace.complete({ input: 200, cacheRead: 70, output: 20 }, 90, second);
  assert.equal(trace.requests[0].firstDeltaMs, 20);
  assert.equal(trace.requests[0].payloadToMessageEndMs, 30);
  assert.equal(trace.requests[1].payloadToMessageEndMs, 70);
  assert.equal(trace.requests[0].usage?.input, 100);
  assert.equal(trace.requests[1].usage?.input, 200);
});

test('cache ratio weights tokens, not per-request percentages, and separates cold starts', () => {
  const summary = summarizeCache([{ taskId: 'a', providerEvidence: { usage: [
    { input: 1000, cacheRead: 0, output: 0 }, { input: 100, cacheRead: 900, output: 0 },
    { input: 2000, cacheRead: 0, output: 0 },
  ] } }]);
  assert.equal(summary.cacheHitPercent, 22.5);
  assert.equal(summary.firstInput, 1000);
  assert.equal(summary.zeroCacheAfterFirst, 1);
  assert.equal(summary.calls, 3);
  assert.equal(summarizeCache([]).cacheHitPercent, 0);
});
