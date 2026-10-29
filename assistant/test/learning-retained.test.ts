import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRetained, retainedResults, RETAINED_DATASET, RETAINED_DATASET_HASH } from '../src/memory/retained-evaluator.ts';
import { sha256 } from '../src/hash.ts';

test('synthetic retained examples give individual deterministic results and provenance', () => {
  const text = 'dashboard status: task in progress; completed tasks';
  const result = retainedResults(text);
  assert.equal(result.score, 4);
  assert.equal(result.total, 4);
  assert.deepEqual(result.results.map(item => item.passed), [true, true, true, true]);
  assert.equal(evaluateRetained(text, 'ignored'), 4);
  assert.equal(result.datasetHash, sha256(JSON.stringify(RETAINED_DATASET)));
  assert.equal(result.datasetHash, RETAINED_DATASET_HASH);
  assert.equal(retainedResults('dashboard').score, 1);
  assert.equal(retainedResults('').score, 0);
});
