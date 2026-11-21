
import { performance } from 'node:perf_hooks';
import { previewOutput } from '../../src/output-preview.ts';

const fixtures = {
  log: Array.from({ length: 20000 }, (_, i) => i % 97 === 0 ? `ERROR TS2345 at line ${i}: expected argument` : `compiling unit ${i} with unchanged settings`).join('\n'),
  diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n' + Array.from({ length: 10000 }, (_, i) => `@@ -${i},1 +${i},1 @@\n-old ${i}\n+new ${i}`).join('\n'),
  search: Array.from({ length: 15000 }, (_, i) => `src/file${i}.ts:${i + 1}:symbol value`).join('\n'),
};

const metrics = [];
for (const [name, text] of Object.entries(fixtures)) {
  const result = previewOutput(text);
  for (let i = 0; i < 5; i++) previewOutput(text);
  const samples = [];
  for (let i = 0; i < 21; i++) {
    const start = performance.now();
    for (let j = 0; j < 3; j++) previewOutput(text);
    samples.push((performance.now() - start) / 3);
  }
  samples.sort((a, b) => a - b);
  const medianMs = Math.round(samples[10] * 1000) / 1000;
  metrics.push(
    { metric: `output_preview.${name}_bytes`, value: result.previewBytes, unit: 'bytes', lowerIsBetter: true, tolerancePct: 5 },
    { metric: `output_preview.${name}_median_ms`, value: medianMs, unit: 'ms', lowerIsBetter: true, tolerancePct: 35 },
  );
}

console.log(JSON.stringify(metrics));
