import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERFORMANCE_BUDGETS,
  assembleOfflineContext,
  createOfflineMemory,
  runPerformanceBenchmark,
} from './performance-benchmark.ts';

test('real OptChat schemas and assembled offline context stay within deterministic byte/token budgets', async () => {
  const firstMemory = createOfflineMemory();
  const secondMemory = createOfflineMemory();
  try {
    const base = assembleOfflineContext(firstMemory);
    const baseAgain = assembleOfflineContext(secondMemory);
    const withDiagnostics = assembleOfflineContext(firstMemory, true);
    const diagnosticsAgain = assembleOfflineContext(secondMemory, true);

    assert.deepEqual(base.sizes, baseAgain.sizes);
    assert.deepEqual(withDiagnostics.sizes, diagnosticsAgain.sizes);
    assert.equal(JSON.stringify(base.tools), JSON.stringify(baseAgain.tools));
    assert.equal(JSON.stringify(base.messages), JSON.stringify(baseAgain.messages));
    assert.equal(JSON.stringify(withDiagnostics.tools), JSON.stringify(diagnosticsAgain.tools));
    assert.equal(base.sizes.memoryEntries, 256);
    assert.equal(base.sizes.memoryViewLines, 129);
    assert.deepEqual(base.tools.map(tool => tool.name), ['zoom', 'date', 'search', 'output_read']);
    assert.deepEqual(withDiagnostics.tools.map(tool => tool.name), ['zoom', 'date', 'search', 'output_read', 'context_metrics']);
    assert.ok(base.sizes.toolSchemaBytes <= PERFORMANCE_BUDGETS.baseToolSchemaBytes);
    assert.ok(withDiagnostics.sizes.toolSchemaBytes <= PERFORMANCE_BUDGETS.diagnosticsToolSchemaBytes);
    for (const sizes of [base.sizes, withDiagnostics.sizes]) {
      assert.ok(sizes.requestBytes <= PERFORMANCE_BUDGETS.assembledRequestBytes);
      assert.ok(sizes.estimatedContextTokens <= PERFORMANCE_BUDGETS.estimatedContextTokens);
      assert.ok(sizes.instructionBytes > 0);
    }
    assert.ok(withDiagnostics.sizes.toolSchemaBytes > base.sizes.toolSchemaBytes);
    const serialized = JSON.stringify(base.messages);
    assert.match(serialized, /synthetic release checks/);
    assert.match(serialized, /Keep the release checks offline/);
    assert.match(serialized, /no provider or external state was used/);
    assert.match(serialized, /synthetic offline workload/);
  } finally {
    await Promise.all([firstMemory.close(), secondMemory.close()]);
  }
});

test('offline performance benchmark reports repetitions and timings without making timing a pass criterion', async () => {
  const report = await runPerformanceBenchmark(3);
  assert.equal(report.kind, 'offline-synthetic-measurement');
  assert.equal(report.workload.repetitions, 3);
  assert.equal(report.workload.warmups, 2);
  assert.equal(report.workload.providerCalls, 0);
  assert.equal(report.workload.userProfileReads, 0);
  assert.equal(report.workload.externalWrites, 0);
  for (const snapshot of [report.processMemory.beforeWorkload, report.processMemory.afterMeasurements]) {
    assert.ok(snapshot.rssBytes > 0);
    assert.ok(snapshot.heapUsedBytes > 0);
    assert.ok(snapshot.externalBytes >= 0);
  }
  for (const timing of Object.values(report.timings)) {
    assert.ok(timing.minMs >= 0);
    assert.ok(timing.minMs <= timing.medianMs);
    assert.ok(timing.medianMs <= timing.p95Ms);
    assert.ok(timing.p95Ms <= timing.maxMs);
  }
  assert.match(report.interpretation, /not provider latency, billing, or task success/);
});
