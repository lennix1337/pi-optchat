import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HeapInfo } from 'node:v8';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Memory, HOT_TEXTS } from '../src/memory.ts';
import { heapReport, type HeapDeps } from '../src/heap-report.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

const registered = () => {
  const tools = new Map<string, ToolDefinition>();
  optchat({ on() {}, events: { on: () => () => {} }, registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} } as unknown as ExtensionAPI);
  return tools;
};
const MB = 1024 * 1024;
const stats = (used: number, limit: number): HeapInfo => ({ used_heap_size: used, heap_size_limit: limit, total_heap_size: used, total_physical_size: used, total_available_size: limit - used,
  total_heap_size_executable: 0, malloced_memory: 0, peak_malloced_memory: 0, does_zap_garbage: 0, number_of_native_contexts: 1, number_of_detached_contexts: 0,
  total_global_handles_size: 0, used_global_handles_size: 0, external_memory: 0 });
const injected = (over: Partial<HeapDeps> = {}): HeapDeps & { written: string[] } => {
  const written: string[] = [];
  return { heapStats: () => stats(300 * MB, 4096 * MB), freeMemory: () => 8192 * MB, writeSnapshot: file => { written.push(file); return file; },
    summarize: async () => ({ topConstructors: [] }), written, ...over } as HeapDeps & { written: string[] };
};

test('heap_report is a read-only deferred tool that stays out of the default tool set', () => {
  const tool = registered().get('heap_report');
  assert.ok(tool, 'heap_report must be registered next to context_metrics');
  assert.equal(tool.exposure, 'deferred');
  assert.equal(tool.defaultActive, false);
  assert.equal(tool.annotations?.readOnlyHint, true);
});

test('a memory of N rows reports root=N and keeps at most the hot texts in RAM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-heap-'));
  const total = HOT_TEXTS + 40, date = '2026-10-09T12:00:00.000Z';
  const line = (value: object) => `${JSON.stringify(value)}\n`;
  mkdirSync(join(dir, 'main')); mkdirSync(join(dir, 'tree'));
  writeFileSync(join(dir, 'main', '2026-10-09.jsonl'), Array.from({ length: total }, (_, i) => line({ i, kind: 'user', text: `Original ${i}`, size: 0, date })).join(''));
  writeFileSync(join(dir, 'tree', '2026-10-09.jsonl'), Array.from({ length: total }, (_, i) => line({ l: 0, i, text: `user: Original ${i}`, size: 0 })).join(''));
  const memory = new Memory(dir, async input => input.source.slice(0, 60), () => {}, 4000);
  try {
    const stats = memory.stats(), treeNodes = memory.tree.size; // summaries keep merging in the background
    const report = await heapReport({}, { optchat: { memory: stats, run: 7, reloads: 3, collections: {} } }, injected());
    const side = report.optchat as { memory: Record<string, number>; run: number; reloads: number };
    assert.equal(side.memory.root, total);
    assert.ok(side.memory.liveTexts <= HOT_TEXTS && side.memory.liveTexts > 0, `live texts ${side.memory.liveTexts}`);
    assert.ok(side.memory.liveTextBytes > 0);
    assert.equal(side.memory.treeNodes, treeNodes);
    assert.ok(side.memory.treeTextBytes > 0);
    assert.equal(side.memory.storeLines, total);
    assert.equal(side.memory.searchCacheQueries, 0);
    memory.search('Original 17');
    assert.equal(memory.stats().searchCacheQueries, 1);
    assert.equal(side.run, 7); assert.equal(side.reloads, 3);
  } finally { await memory.close(); removeDir(dir); }
});

test('the report carries process, V8, event-loop and listener numbers, and a listener added now is counted', async () => {
  const before = (await heapReport({}, {}, injected())).process as { exitListeners: number; activeResources: { total: number } };
  const listener = () => {};
  process.on('exit', listener);
  try {
    const after = await heapReport({}, {}, injected());
    assert.equal((after.process as { exitListeners: number }).exitListeners, before.exitListeners + 1);
    assert.equal((after.process as { exitListeners: number }).exitListeners, process.listenerCount('exit'));
  } finally { process.off('exit', listener); }
  const report = await heapReport({}, {}, injected());
  for (const key of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) assert.equal(typeof (report.memoryUsage as Record<string, number>)[key], 'number');
  assert.ok((report.v8 as { spaces: unknown[] }).spaces.length > 0);
  assert.ok((report.process as { activeResources: { total: number } }).activeResources.total >= 0);
  assert.equal(typeof (report.eventLoop as { p99Ms: number }).p99Ms, 'number');
  assert.equal(report.gc, undefined); assert.equal(report.snapshot, undefined);
});

test('the event-loop delay is measured from load and reset after each report', async () => {
  await heapReport({}, {}, injected());
  await new Promise(resolve => setImmediate(resolve)); // a block inside a timer callback is under-reported by libuv; real stalls are not
  const end = Date.now() + 120;
  while (Date.now() < end) { /* block the loop so the monitor sees a delay */ }
  await new Promise(resolve => setTimeout(resolve, 30));
  const first = (await heapReport({}, {}, injected())).eventLoop as { maxMs: number; samples: number };
  assert.ok(first.maxMs >= 80, `blocked loop shows in the max (${first.maxMs} ms)`);
  const second = (await heapReport({}, {}, injected())).eventLoop as { maxMs: number; samples: number };
  assert.ok(second.maxMs < first.maxMs, 'the next report starts from a reset histogram');
});

test('a snapshot is refused when the heap is over a quarter of its limit or memory is short, and nothing is written', async () => {
  const big = injected({ heapStats: () => stats(1100 * MB, 4096 * MB) });
  const refused = await heapReport({ snapshot: true }, {}, big);
  assert.equal((refused.snapshot as { refused: boolean }).refused, true);
  assert.match((refused.snapshot as { reason: string }).reason, /25%/);
  const short = injected({ freeMemory: () => 500 * MB });
  const lowMemory = await heapReport({ snapshot: true }, {}, short);
  assert.equal((lowMemory.snapshot as { refused: boolean }).refused, true);
  assert.match((lowMemory.snapshot as { reason: string }).reason, /free memory/);
  assert.deepEqual([...big.written, ...short.written], []);
  const fine = injected();
  const taken = await heapReport({ snapshot: true }, {}, fine);
  assert.equal(fine.written.length, 1);
  assert.match(fine.written[0], /\.heapsnapshot$/);
  assert.equal((taken.snapshot as { refused?: boolean }).refused, undefined);
  const keys = Object.keys(taken);
  assert.equal(keys.indexOf('snapshot'), keys.indexOf('summary') + 1, 'the snapshot file sits right after the summary, so a short read of the report finds it');
});

test('gc:true forces a collection and reports the heap before and after with the pause', async () => {
  let collected = 0;
  const report = await heapReport({ gc: true }, {}, injected({ collect: () => { collected++; } }));
  assert.equal(collected, 1);
  const gc = report.gc as { pauseMs: number; heapUsedBefore: number; heapUsedAfter: number };
  assert.ok(gc.pauseMs >= 0); assert.equal(typeof gc.heapUsedBefore, 'number'); assert.equal(typeof gc.heapUsedAfter, 'number');
  const real = await heapReport({ gc: true }, {}); // the real collector, through V8 flags and a fresh vm context
  assert.ok((real.gc as { pauseMs: number }).pauseMs > 0);
});

test('a real snapshot and a real GC never touch the inspector: no "Debugger attached" and no inspector API in the source', async () => {
  const seen: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { seen.push(String(chunk)); return (write as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
  let file: string | undefined;
  try {
    const report = await heapReport({ gc: true, snapshot: true }, {});
    const snapshot = report.snapshot as { refused?: boolean; file?: string; bytes?: number; topConstructors?: { name: string; count: number; selfBytes: number }[]; summaryError?: string };
    assert.equal(snapshot.refused, undefined, JSON.stringify(snapshot));
    file = snapshot.file;
    assert.ok(file && existsSync(file) && snapshot.bytes! > 0);
    assert.equal(snapshot.summaryError, undefined);
    assert.ok(snapshot.topConstructors!.length > 0);
    assert.ok(snapshot.topConstructors!.some(c => c.name === 'Object' || c.name === 'Array'), JSON.stringify(snapshot.topConstructors));
    assert.ok(snapshot.topConstructors!.every(c => c.count > 0 && c.selfBytes > 0));
  } finally { process.stderr.write = write as typeof process.stderr.write; if (file) rmSync(file, { force: true }); }
  assert.doesNotMatch(seen.join(''), /Debugger attached|Debugger listening/);
  const source = readFileSync(new URL('../src/heap-report.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /_debugProcess|node:inspector|--inspect|inspector\.open/);
});

test('a real Pi turn records pi_pre_request and pi_boundary, and heap_report reads the live session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-heap-runtime-'));
  const prior = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(root, 'home');
  const profile = 'heap-report'; createProfile(profile);
  saveConfig(profilePath(profile), { ...loadConfig(profilePath(profile)), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
  let calls = 0, heap = '', metrics = '';
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      let content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop';
      if (isCompaction(context)) content = [{ type: 'text', text: 'echo: compacted.' }];
      else {
        const result = (name: string) => { const last = context.messages.findLast(m => m.role === 'toolResult' && m.toolName === name); return last?.role === 'toolResult' ? textContent(last.content) : ''; };
        if (calls === 0) { content = [{ type: 'toolCall', id: 'heap', name: 'heap_report', arguments: { gc: true } }]; stopReason = 'toolUse'; }
        else if (calls === 1) { heap = result('heap_report'); content = [{ type: 'toolCall', id: 'metrics', name: 'context_metrics', arguments: {} }]; stopReason = 'toolUse'; }
        else { metrics = result('context_metrics'); content = [{ type: 'text', text: 'Measured.' }]; }
        calls++;
      }
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); }); return stream;
    } });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(root, join(root, 'sessions'));
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager,
    tools: ['heap_report', 'context_metrics'] });
  session.extensionRunner!.setFlagValue('optchat-profile', profile);
  try {
    await session.bindExtensions({ mode: 'print', onError: error => { throw new Error(error.error); } });
    await session.prompt('Measure this session.');
    assert.equal(calls, 3);
    const stages = JSON.parse(metrics).stages;
    assert.ok(stages.pi_pre_request.count >= 2, JSON.stringify(Object.keys(stages)));
    assert.ok(stages.pi_boundary.count >= 1);
    assert.ok(stages.pi_pre_request.maxMs >= 0 && stages.pi_boundary.maxMs >= 0);
    const report = JSON.parse(heap);
    assert.ok(report.gc.pauseMs > 0);
    assert.ok(report.pi.entries >= 2 && report.pi.contextEntries >= 2 && report.pi.sinceCompaction >= 2, JSON.stringify(report.pi));
    assert.ok(report.pi.sessionFileBytes > 0);
    assert.ok(report.optchat.memory.root >= 2); assert.ok(report.optchat.run >= 1);
    assert.equal(report.optchat.reloads, 0);
    // Counts of the collections that live as long as the process, so a growing one can be named without a snapshot.
    const sizes = report.optchat.collections;
    for (const name of ['childrenRunning', 'childrenRunMessages', 'runHistory', 'shellJobs', 'shellOutputChars', 'receipts', 'bundles', 'runMessages', 'heldWakeMessages', 'peerCopies'])
      assert.equal(typeof sizes[name], 'number', `${name} in ${JSON.stringify(sizes)}`);
    assert.ok(sizes.runMessages >= 1);
    if (process.env.HEAP_REPORT_SAMPLE) writeFileSync(process.env.HEAP_REPORT_SAMPLE, heap);
  } finally {
    await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    if (prior === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = prior;
    removeDir(root);
  }
});
