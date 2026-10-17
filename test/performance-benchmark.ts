// Offline, synthetic performance measurements. Never loads user profiles or invokes a model/provider.
import assert from 'node:assert/strict';
import { cpus, availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Memory } from '../src/memory.ts';
import type { Store } from '../src/store.ts';
import { buildContext } from '../src/transcript.ts';
import { estimatedContextTokens } from '../src/run-context.ts';
import { MASTER, VIEW_DOC, SEARCH_DOC, IMPORT_GUIDANCE } from '../src/prompts.ts';
import { memoryTools, searchTool } from '../src/tools.ts';
import { outputReadTool, type OutputContext } from '../src/output-context.ts';
import { PerformanceMetrics, performanceTool } from '../src/performance.ts';

export const PERFORMANCE_BUDGETS = {
  baseToolSchemaBytes: 8_192,
  diagnosticsToolSchemaBytes: 10_240,
  assembledRequestBytes: 32_768,
  estimatedContextTokens: 10_000,
} as const;

const MEMORY_ENTRIES = 256;
const RECENT_ENTRIES = MEMORY_ENTRIES / 2;
const WARMUPS = 2;
const DEFAULT_REPEATS = 9;
const OFFLINE_DIRECTORY = 'offline-performance-fixture';
const OFFLINE_INSTRUCTIONS = `<project_context>\nProject: synthetic offline workload.\nUse only the supplied fixture; do not access user profiles, networks, production systems, or external services. Preserve test evidence and report uncertainty.\n</project_context>`;
const OFFLINE_PROMPT = [MASTER, VIEW_DOC, SEARCH_DOC, IMPORT_GUIDANCE, OFFLINE_INSTRUCTIONS].join('\n\n');
const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function syntheticSaved() {
  const entries = Array.from({ length: MEMORY_ENTRIES }, (_, i) => {
    const kind = (['user', 'talk', 'tool', 'echo', 'work', 'note'] as const)[i % 6];
    const text = kind === 'echo' ? `Synthetic check ${i}: 24 passed, 1 skipped; no provider calls.`
      : kind === 'tool' ? `read fixture-${i}.json page 1; result retained in offline memory.`
        : `Synthetic ${kind} message ${i}: preserve the decision, evidence, and next step.`;
    return { i, kind, text, size: Buffer.byteLength(`${kind}: ${text}`), date: '2026-01-01T00:00:00.000Z' };
  });
  const tree: { l: number; i: number; text: string }[] = [];
  for (let level = 0; 2 ** level <= MEMORY_ENTRIES; level++) {
    const count = MEMORY_ENTRIES / 2 ** level;
    for (let i = 0; i < count; i++) {
      const first = i * 2 ** level, last = first + 2 ** level - 1;
      const text = level === 0 ? `${entries[first].kind}: ${entries[first].text}`
        : `Synthetic summary covering messages ${first}–${last}; decisions, checks, and uncertainty retained.`;
      tree.push({ l: level, i, text });
    }
  }
  const view = JSON.stringify([[7, 0], ...Array.from({ length: RECENT_ENTRIES }, (_, i) => [0, RECENT_ENTRIES + i])]);
  return { entries, tree, view };
}

/** Build a bounded in-memory history with a no-op Store; the compressor is unreachable because every summary is present. */
export function createOfflineMemory() {
  const saved = syntheticSaved();
  const store: Store = {
    load: () => saved,
    append: () => undefined,
    appendNode: () => undefined,
    saveView: () => undefined,
    putImage: () => undefined,
    image: () => undefined,
  };
  return new Memory({ directory: OFFLINE_DIRECTORY, store, saved }, async () => {
    throw new Error('Offline performance fixture must not invoke a compressor.');
  }, () => {});
}

function assistantText(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp: 1, stopReason: 'stop', usage: EMPTY_USAGE,
    api: 'openai-completions', provider: 'offline-fixture', model: 'offline-fixture' };
}

/** Assemble a Pi-shaped request from OptChat's real prompt, tool schemas and transcript builder. */
export function assembleOfflineContext(memory: Memory, includeDiagnostics = false) {
  const metrics = new PerformanceMetrics();
  const outputContext = undefined as unknown as OutputContext; // Tool schemas are measured; no tool is executed.
  const baseTools = [
    ...memoryTools(() => memory),
    searchTool(() => memory),
    outputReadTool(() => outputContext),
  ].map(({ name, description, parameters }) => ({ name, description, parameters }));
  const diagnosticTools = [performanceTool(() => metrics, () => ({ stored: 0, reads: 0 }))]
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  const toolsAdded = includeDiagnostics ? [...baseTools, ...diagnosticTools] : baseTools;
  const canonical: AgentMessage[] = [{ role: 'system', content: 'Pi offline runtime system prompt fixture.', toolsAdded, timestamp: 0 }];
  const previous: AgentMessage[] = [
    { role: 'user', content: 'Keep the release checks offline and preserve their evidence.', timestamp: 0 },
    assistantText('Understood. The synthetic checks are isolated; no provider or external state was used.'),
  ];
  const run: AgentMessage[] = [{ role: 'user', content: 'Summarize the synthetic release checks and identify any unresolved risk.', timestamp: 1 }];
  const view = memory.render();
  const messages = buildContext(canonical, run, view, OFFLINE_PROMPT, previous,
    'Working directory: <offline fixture>', '[OptChat status] No agents running.');
  metrics.context(messages);
  const request = metrics.snapshot().request;
  const requestBytes = Buffer.byteLength(JSON.stringify(messages));
  const toolSchemaBytes = Buffer.byteLength(JSON.stringify(toolsAdded));
  assert.equal(request.toolSchemaBytes, toolSchemaBytes, 'telemetry schema byte count must match serialized active schemas');
  assert.equal(request.estimatedTokens, estimatedContextTokens(messages), 'telemetry estimate must match the assembled Pi request');
  return {
    messages,
    tools: toolsAdded,
    sizes: {
      memoryEntries: memory.root.length,
      memoryViewLines: memory.view.length,
      toolCount: toolsAdded.length,
      toolSchemaBytes,
      systemBytes: request.systemBytes,
      instructionBytes: request.instructionBytes,
      skillCatalogueBytes: request.skillCatalogueBytes,
      requestBytes,
      estimatedContextTokens: request.estimatedTokens,
    },
  };
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
function distribution(values: number[]) {
  return { minMs: Number(Math.min(...values).toFixed(3)), medianMs: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)), maxMs: Number(Math.max(...values).toFixed(3)) };
}
function assertBudget(sizes: ReturnType<typeof assembleOfflineContext>['sizes'], diagnostics: boolean) {
  const schemaLimit = diagnostics ? PERFORMANCE_BUDGETS.diagnosticsToolSchemaBytes : PERFORMANCE_BUDGETS.baseToolSchemaBytes;
  assert.ok(sizes.toolSchemaBytes <= schemaLimit, `tool schemas ${sizes.toolSchemaBytes}B exceed ${schemaLimit}B budget`);
  assert.ok(sizes.requestBytes <= PERFORMANCE_BUDGETS.assembledRequestBytes,
    `assembled request ${sizes.requestBytes}B exceeds ${PERFORMANCE_BUDGETS.assembledRequestBytes}B budget`);
  assert.ok(sizes.estimatedContextTokens <= PERFORMANCE_BUDGETS.estimatedContextTokens,
    `assembled request estimate ${sizes.estimatedContextTokens} tokens exceeds ${PERFORMANCE_BUDGETS.estimatedContextTokens} token budget`);
}

export async function runPerformanceBenchmark(repeats = DEFAULT_REPEATS) {
  assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 50, 'repeats must be an integer from 3 to 50');
  const memoryBeforeWorkload = process.memoryUsage();
  const samples = { memoryConstruction: [] as number[], memoryRender: [] as number[], baseContextAssembly: [] as number[], diagnosticsContextAssembly: [] as number[] };
  let stableSizes: { base: ReturnType<typeof assembleOfflineContext>['sizes']; diagnostics: ReturnType<typeof assembleOfflineContext>['sizes'] } | undefined;
  for (let trial = -WARMUPS; trial < repeats; trial++) {
    const constructionStart = performance.now();
    const memory = createOfflineMemory();
    const memoryConstructionMs = performance.now() - constructionStart;
    const renderStart = performance.now();
    memory.render();
    const memoryRenderMs = performance.now() - renderStart;
    const baseStart = performance.now();
    const base = assembleOfflineContext(memory);
    const baseContextAssemblyMs = performance.now() - baseStart;
    const diagnosticStart = performance.now();
    const diagnostics = assembleOfflineContext(memory, true);
    const diagnosticsContextAssemblyMs = performance.now() - diagnosticStart;
    assertBudget(base.sizes, false);
    assertBudget(diagnostics.sizes, true);
    const sizes = { base: base.sizes, diagnostics: diagnostics.sizes };
    if (stableSizes) assert.deepEqual(sizes, stableSizes, 'synthetic schema and request sizes must be deterministic');
    else stableSizes = sizes;
    if (trial >= 0) {
      samples.memoryConstruction.push(memoryConstructionMs);
      samples.memoryRender.push(memoryRenderMs);
      samples.baseContextAssembly.push(baseContextAssemblyMs);
      samples.diagnosticsContextAssembly.push(diagnosticsContextAssemblyMs);
    }
    await memory.close();
  }
  const memoryAfterMeasurements = process.memoryUsage();
  const cpu = cpus()[0];
  return {
    kind: 'offline-synthetic-measurement',
    environment: { node: process.version, platform: process.platform, release: process.release.name, arch: process.arch,
      logicalCores: availableParallelism(), cpuModel: cpu?.model ?? 'unknown' },
    workload: { memoryEntries: MEMORY_ENTRIES, memoryViewLines: stableSizes!.base.memoryViewLines,
      activeBaseTools: ['zoom', 'date', 'search', 'output_read'], optionalDiagnosticsTool: 'context_metrics',
      warmups: WARMUPS, repetitions: repeats, providerCalls: 0, userProfileReads: 0, externalWrites: 0 },
    budgets: PERFORMANCE_BUDGETS,
    processMemory: {
      beforeWorkload: { rssBytes: memoryBeforeWorkload.rss, heapUsedBytes: memoryBeforeWorkload.heapUsed, externalBytes: memoryBeforeWorkload.external },
      afterMeasurements: { rssBytes: memoryAfterMeasurements.rss, heapUsedBytes: memoryAfterMeasurements.heapUsed, externalBytes: memoryAfterMeasurements.external },
      note: 'Whole benchmark-process snapshots; includes loaded modules and allocator/GC effects, not an isolated fixture delta.',
    },
    sizes: stableSizes,
    timings: {
      memoryConstruction: distribution(samples.memoryConstruction),
      memoryRender: distribution(samples.memoryRender),
      baseContextAssemblyAndTelemetry: distribution(samples.baseContextAssembly),
      diagnosticsContextAssemblyAndTelemetry: distribution(samples.diagnosticsContextAssembly),
    },
    interpretation: 'Local CPU/runtime measurements and Pi token estimates only; not provider latency, billing, or task success. No before/after gain is claimed.',
  };
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/performance-benchmark.ts')) {
  const repeats = Number(process.env.PERF_REPEATS ?? DEFAULT_REPEATS);
  runPerformanceBenchmark(repeats).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
