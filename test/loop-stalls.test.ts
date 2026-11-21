import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:perf_hooks';
import { createStallWatch, registerStallPhases, spanHooks, spanned, stallWatch } from '../src/loop-stalls.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { heapReport } from '../src/heap-report.ts';

const clock = () => { let t = 1000; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

test('a tick that arrives on time records nothing; a late one records the blocked time', () => {
  const c = clock(), watch = createStallWatch(c.now, () => Date.parse('2026-11-13T12:00:00Z'));
  c.advance(100); watch.tick();
  assert.deepEqual(watch.stalls(), []);
  c.advance(10_100); watch.tick();
  assert.deepEqual(watch.stalls(), [{ at: '2026-11-13T12:00:00.000Z', blockedMs: 10_000, gcMs: 0, gcKind: null }]);
});

test('a garbage collection inside the stall window is named as its cause; one outside is not', () => {
  const c = clock(), watch = createStallWatch(c.now);
  watch.noteGc(1000 - 500, 50, 2);
  watch.noteGc(1300, 400, constants.NODE_PERFORMANCE_GC_MAJOR);
  watch.noteGc(1750, 30, constants.NODE_PERFORMANCE_GC_MINOR);
  c.advance(1100); watch.tick();
  const [stall] = watch.stalls();
  assert.equal(stall.blockedMs, 1000);
  assert.equal(stall.gcMs, 430);
  assert.equal(stall.gcKind, 'mark-sweep-compact');
});

test('GC notifications arriving after the watchdog tick update the overlapping stall', () => {
  const c = clock(), watch = createStallWatch(c.now);
  c.advance(1100); watch.tick();
  watch.noteGc(1300, 400, constants.NODE_PERFORMANCE_GC_MAJOR);
  watch.noteGc(1750, 30, constants.NODE_PERFORMANCE_GC_MINOR);
  watch.noteGc(2200, 50, constants.NODE_PERFORMANCE_GC_MINOR);
  const [stall] = watch.stalls();
  assert.equal(stall.gcMs, 430);
  assert.equal(stall.gcKind, 'mark-sweep-compact');
});

test('GC kinds use the runtime constants', () => {
  for (const [kind, label] of [
    [constants.NODE_PERFORMANCE_GC_MINOR, 'scavenge'],
    [2, 'minor-mark-sweep'],
    [constants.NODE_PERFORMANCE_GC_MAJOR, 'mark-sweep-compact'],
    [constants.NODE_PERFORMANCE_GC_INCREMENTAL, 'incremental'],
    [constants.NODE_PERFORMANCE_GC_WEAKCB, 'weak-callbacks'],
  ] as const) {
    const c = clock(), watch = createStallWatch(c.now);
    watch.noteGc(1300, 100, kind);
    c.advance(1100); watch.tick();
    assert.equal(watch.stalls()[0].gcKind, label);
  }
});

test('only the last 20 stalls are kept', () => {
  const c = clock(), watch = createStallWatch(c.now);
  for (let i = 0; i < 25; i++) { c.advance(1000); watch.tick(); }
  assert.equal(watch.stalls().length, 20);
});

test('a long active span survives the bounded history of short finished spans', () => {
  const c = clock(), watch = createStallWatch(c.now);
  const end = watch.begin('phase:assistant-stream');
  for (let i = 0; i < 150; i++) watch.begin('hook:message_update')();
  c.advance(100); watch.tick();
  c.advance(500); watch.tick();
  assert.deepEqual(watch.stalls()[0].during, ['phase:assistant-stream']);
  end();
});

test('phase spans distinguish provider streaming, bash result handling and idle without recording inputs', () => {
  const c = clock(), watch = createStallWatch(c.now), handlers = new Map<string, (event: any) => unknown>();
  const pi = { on: (name: string, handler: (event: any) => unknown) => handlers.set(name, handler) } as unknown as ExtensionAPI;
  registerStallPhases(pi, watch);
  const emit = (name: string, event: object = {}) => handlers.get(name)?.(event);
  emit('agent_start'); emit('turn_start'); emit('before_provider_request'); emit('message_start', { message: { role: 'assistant' } });
  c.advance(500); watch.tick();
  assert.deepEqual(watch.stalls()[0].during, ['phase:agent', 'phase:turn', 'phase:provider', 'phase:assistant-stream']);
  emit('message_end', { message: { role: 'assistant' } });
  emit('tool_execution_start', { toolName: 'bash', toolCallId: 'secret-id' });
  emit('tool_call', { toolName: 'bash', toolCallId: 'secret-id', input: { command: 'private command' } });
  c.advance(500); watch.tick();
  assert.ok(watch.stalls()[1].during?.includes('phase:bash-call-to-result'));
  emit('tool_result', { toolName: 'bash', toolCallId: 'secret-id', content: 'private output' });
  c.advance(500); watch.tick();
  assert.ok(watch.stalls()[2].during?.includes('phase:bash-result-to-end'));
  assert.ok(!watch.stalls()[2].during?.includes('phase:bash-call-to-result'));
  emit('tool_execution_end', { toolName: 'bash', toolCallId: 'secret-id' }); emit('turn_end'); emit('agent_settled');
  c.advance(500); watch.tick();
  assert.equal(watch.stalls()[3].during, undefined);
  emit('session_before_compact'); c.advance(500); watch.tick();
  assert.ok(watch.stalls()[4].during?.includes('phase:compact'));
  emit('session_compact_failed'); c.advance(500); watch.tick();
  assert.equal(watch.stalls()[5].during, undefined);
  emit('tool_execution_start', { toolName: 'bash', toolCallId: 'secret-id' });
  emit('tool_call', { toolName: 'bash', toolCallId: 'secret-id' }); emit('session_shutdown');
  c.advance(500); watch.tick(); assert.equal(watch.stalls()[6].during, undefined);
  assert.doesNotMatch(JSON.stringify(watch.stalls()), /private|secret-id/);
});

test('heap_report carries the stall list inside eventLoop', async () => {
  const report = await heapReport({}, {});
  assert.ok(Array.isArray((report.eventLoop as { stalls: unknown }).stalls));
});

test('a stall names instrumented tools overlapping its window; no span makes no claim about uninstrumented work', () => {
  const c = clock(), watch = createStallWatch(c.now);
  const early = watch.begin('tool:read'); c.advance(100); early();
  watch.tick();
  const bash = watch.begin('tool:bash');
  const grep = watch.begin('tool:grep'); c.advance(500); grep();
  c.advance(700); watch.tick();
  assert.deepEqual(watch.stalls()[0].during, ['tool:bash', 'tool:grep']);
  bash();
  c.advance(1100); watch.tick();
  assert.equal(watch.stalls()[1].during, undefined, 'a stall with no tool in flight carries no tool names');
});

test('a watchdog left in the process by an older build (before an extension reload) is replaced, keeping its stalls', () => {
  const key = Symbol.for('pi-optchat.loop-stalls'), slot = globalThis as Record<symbol, unknown>, saved = slot[key];
  const old = { at: '2026-11-14T09:41:16.098Z', blockedMs: 3173, gcMs: 7, gcKind: 'scavenge' };
  slot[key] = { tick() {}, noteGc() {}, stalls: () => [old] };
  try {
    const watch = stallWatch();
    assert.equal(typeof watch.begin, 'function');
    assert.deepEqual(watch.stalls(), [old]);
    assert.equal(stallWatch(), watch);
  } finally { (slot[key] as { stop?: () => void } | undefined)?.stop?.(); slot[key] = saved; }
});

test('spanHooks names a stall inside a hook handler, sync or async, and keeps the handler result', async () => {
  const c = clock(), watch = createStallWatch(c.now);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = { on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); } };
  const hooked = spanHooks(pi, watch);
  const original = pi.on;
  hooked.on('context_with_system', () => { c.advance(1100); watch.tick(); return 'kept'; });
  hooked.on('message_end', async () => { c.advance(1100); watch.tick(); await null; return 7; });
  assert.equal(handlers.get('context_with_system')!(), 'kept');
  assert.equal(await handlers.get('message_end')!(), 7);
  assert.deepEqual(watch.stalls().map(s => s.during), [['hook:context_with_system'], ['hook:message_end']]);
  c.advance(1100); watch.tick();
  assert.equal(watch.stalls()[2].during, undefined, 'a hook that returned is no longer in flight');
  assert.equal(pi.on, original, 'the host object is not mutated (a host Proxy keeps its own on)');
});

test('tool completion stalls distinguish OptChat handlers without exposing source paths', () => {
  const c = clock(), watch = createStallWatch(c.now);
  const handlers: ((...args: unknown[]) => unknown)[] = [];
  const pi = spanHooks({ on: (_event: string, handler: (...args: unknown[]) => unknown) => { handlers.push(handler); } }, watch);
  pi.on('tool_result', () => { c.advance(500); watch.tick(); });
  pi.on('tool_result', () => { c.advance(500); watch.tick(); });
  handlers.forEach(handler => handler());
  const names = watch.stalls().map(stall => stall.during?.find(name => name.startsWith('handler:tool_result:')));
  assert.match(names[0] ?? '', /^handler:tool_result:loop-stalls\.test\.ts:\d+$/);
  assert.match(names[1] ?? '', /^handler:tool_result:loop-stalls\.test\.ts:\d+$/);
  assert.notEqual(names[0], names[1]);
});

test('spanned names a stall inside one step, sync or async, and ends the span when the step does', async () => {
  const c = clock(), watch = createStallWatch(c.now);
  assert.equal(spanned('open:usage', () => { c.advance(1100); watch.tick(); return 'kept'; }, watch), 'kept');
  assert.equal(await spanned('open:memory', async () => { await null; c.advance(1100); watch.tick(); return 7; }, watch), 7);
  assert.throws(() => spanned('open:crew', () => { throw new Error('boom'); }, watch), /boom/);
  c.advance(1100); watch.tick();
  assert.deepEqual(watch.stalls().map(s => s.during), [['open:usage'], ['open:memory'], undefined]);
});

test('a stall that ran several steps back to back says how long each one held the loop, so the heaviest step is named', () => {
  const c = clock(), watch = createStallWatch(c.now);
  watch.tick();
  const usage = watch.begin('open:usage'); c.advance(300); usage();
  const memory = watch.begin('open:memory'); c.advance(2500); memory();
  const tiny = watch.begin('open:inbox'); tiny();
  c.advance(100); watch.tick();
  const stall = watch.stalls()[0];
  assert.deepEqual(stall.during, ['open:usage', 'open:memory', 'open:inbox']);
  assert.deepEqual(stall.spanMs, { 'open:usage': 300, 'open:memory': 2500 }, 'steps under 10 ms are left out');
});
