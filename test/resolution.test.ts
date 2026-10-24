import assert from 'node:assert/strict';
import test from 'node:test';
import { runResolutionBenchmark } from './resolution-benchmark.ts';

// The navigation rule as a gate: an old topic resolves with a find inside the chosen branch plus one exact read,
// not a level-by-level descent of the tree; a reopened original costs no extra call on later turns.
test('an old topic resolves in 2 calls instead of a 7-call tree descent, and focus re-reads cost no calls', async () => {
  const result = await runResolutionBenchmark();
  const { oldTopic, repeatedRefresh, revokedDecision } = result.fixtures;
  assert.equal(oldTopic.baseline.toolCalls, 7);
  assert.equal(oldTopic.targeted.toolCalls, 2);
  assert.ok(oldTopic.targeted.returnedBytes < oldTopic.baseline.returnedBytes / 10);
  assert.equal(repeatedRefresh.focused.extraToolCalls, 0);
  assert.equal(revokedDecision.currentCorrectionPreserved, true);
  assert.equal(result.providerCalls, 0);
});
