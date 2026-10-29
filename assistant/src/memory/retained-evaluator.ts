import { sha256 } from '../hash.ts';
import type { Evaluator } from './proposals.ts';

/** Synthetic regression examples, not a measurement of personal learning efficacy. */
export const RETAINED_DATASET = {
  id: 'task-display-synthetic-v1',
  provenance: 'Hand-authored synthetic task-display requirements; no personal data or model calls.',
  examples: [
    { id: 'in-progress', required: 'task in progress' },
    { id: 'completed', required: 'completed tasks' },
    { id: 'dashboard', required: 'dashboard' },
    { id: 'status', required: 'status' },
  ],
} as const;

export const RETAINED_DATASET_HASH = sha256(JSON.stringify(RETAINED_DATASET));

/** One point per independently declared retained requirement present in the candidate text. */
export const evaluateRetained: Evaluator = (content: string): number =>
  RETAINED_DATASET.examples.filter(example => content.includes(example.required)).length;

export function retainedResults(content: string): { datasetId: string; datasetHash: string; score: number; total: number; results: { id: string; passed: boolean }[] } {
  const results = RETAINED_DATASET.examples.map(example => ({ id: example.id, passed: content.includes(example.required) }));
  return { datasetId: RETAINED_DATASET.id, datasetHash: RETAINED_DATASET_HASH, score: results.filter(result => result.passed).length, total: results.length, results };
}
