import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildCatchup, renderCatchup } from '../src/catchup.ts';

// Synthetic full-night receipt, not a provider/cache/token benchmark.
const entries = [];
const add = (kind, text) => entries.push({ i: entries.length, kind, text, date: new Date(Date.UTC(2026, 9, 27, 0, entries.length)).toISOString(), size: text.length });
add('user', 'Synthetic operator request');
for (let wake = 0; wake < 14; wake++) {
  add('work', '[OptChat heartbeat] synthetic wake');
  for (let call = 0; call < 30; call++) {
    add('tool', 'codemode {}');
    add('echo', `codemode: Script completed\n${JSON.stringify({ output: JSON.stringify({ url: `https://github.com/synthetic/repo/pull/${wake % 3 + 1}`, state: 'OPEN', statusCheckRollup: [] }), exit_code: 0 })}\n${'synthetic diagnostic '.repeat(100)}`);
  }
  add('talk', `Synthetic work item ${wake}; testing complete, live flow unverified.`);
}
const span = { id: `0-${entries.length}`, from: 0, to: entries.length, start: entries[0].date, end: entries.at(-1).date, provenance: 'interactive' };
const samples = [];
let text;
for (let i = 0; i < 51; i++) {
  const start = performance.now();
  const report = buildCatchup(entries, span);
  text = renderCatchup(report);
  assert.equal(report.wakes.length, 14);
  assert.equal(report.prs.length, 3);
  assert.equal(report.tools, 420);
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
console.log(JSON.stringify({ scope: 'synthetic full-night local receipt, no baseline or end-to-end speedup claim', events: entries.length, wakes: 14, observedPRs: 3, outerToolCalls: 420, originalTextBytes: entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0), medianMs: samples[25], p95Ms: samples[48], summaryBytes: Buffer.byteLength(text), iterations: samples.length, inferenceRequests: 0, networkRequests: 0 }));
