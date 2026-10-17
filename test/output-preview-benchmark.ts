import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewOutput } from '../src/output-preview.ts';

const baselinePath = process.argv[2];
const baseline: typeof previewOutput = baselinePath ? (await import(pathToFileURL(resolve(baselinePath)).href)).previewOutput : previewOutput;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const fixtures = {
  log: Array.from({ length: 20000 }, (_, i) => i % 97 === 0 ? `ERROR TS2345 at line ${i}: expected argument` : `compiling unit ${i} with unchanged settings`).join('\n'),
  diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n' + Array.from({ length: 10000 }, (_, i) => `@@ -${i},1 +${i},1 @@\n-old ${i}\n+new ${i}`).join('\n'),
  search: Array.from({ length: 15000 }, (_, i) => `src/file${i}.ts:${i + 1}:symbol value`).join('\n'),
};
const results = Object.entries(fixtures).map(([name, text]) => {
  const before = baseline(text), after = previewOutput(text);
  assert.deepEqual(after, before, `${name}: optimization must not alter any output or metadata`);
  for (let n = 0; n < 8; n++) { baseline(text); previewOutput(text); }
  const samples: number[][] = [[], []];
  const functions = [baseline, previewOutput];
  for (let n = 0; n < 41; n++) {
    // Alternate execution order within the same process to reduce warm-up/order bias.
    for (const index of n % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      for (let i = 0; i < 3; i++) functions[index](text);
      samples[index].push((performance.now() - start) / 3);
    }
  }
  const timing = samples.map(values => { values.sort((a, b) => a - b); return { medianMs: values[20], p90Ms: values[36] }; });
  return { name, inputBytes: Buffer.byteLength(text), previewBytes: after.previewBytes, digest: digest(JSON.stringify(after)),
    baseline: timing[0], optimized: timing[1], medianReductionPercent: 100 * (1 - timing[1].medianMs / timing[0].medianMs) };
});
console.log(JSON.stringify({ scope: 'production previewOutput component only; no model or end-to-end latency measurement',
  baselineHash: baselinePath ? digest(readFileSync(baselinePath, 'utf8')) : null,
  sourceHash: digest(readFileSync(new URL('../src/output-preview.ts', import.meta.url), 'utf8')), results }, null, 2));
