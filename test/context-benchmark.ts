// Local, synthetic and no inference. Report raw, previous capped view and recoverable projection separately.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { OutputStore } from '../src/output-store.ts';
import { OutputContext } from '../src/output-context.ts';
import { boundedMessage } from '../src/transcript.ts';
import { estimatedContextTokens } from '../src/run-context.ts';
import { memoryTools } from '../src/tools.ts';
import { removeDir } from './support.ts';

export function runContextBenchmark() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-context-bench-'));
  const fixtures = [
    { name: 'genexus-build', progress: 'Generating procedure SyntheticProbe', diagnostics: ['error src0216 Unknown field SyntheticField', 'CS0246 SdtSynthetic missing'], tail: 'Build failed: 2 errors' },
    { name: 'cargo-test', progress: 'test fixture::bounded_case ... ok', diagnostics: ['thread regression panicked at assertion', 'FAILED test fixture::semantic_case'], tail: 'test result: FAILED. 400 passed; 1 failed' },
    { name: 'web-build', progress: 'compiled module synthetic/app', diagnostics: ['TS2322 synthetic type mismatch', 'error: build command failed'], tail: 'Tests: 50 passed, 1 failed; exit code 1' },
  ];
  try {
    return fixtures.map(fixture => {
      const text = `${(fixture.progress + '\n').repeat(900)}${fixture.diagnostics.join('\n')}\n${(fixture.progress + '\n').repeat(900)}${fixture.tail}\n`;
      const message: AgentMessage = { role: 'toolResult', toolName: 'bash', toolCallId: fixture.name, content: [{ type: 'text', text }], isError: true, timestamp: 0 };
      const context = new OutputContext(new OutputStore(dir, fixture.name));
      const started = performance.now(), preview = context.project([message]);
      const coldMs = performance.now() - started;
      const serialized = JSON.stringify(preview);
      const ref = /output:([a-f0-9]{64})/.exec(serialized)![1];
      let extraReads = 0;
      for (const diagnostic of [...fixture.diagnostics, fixture.tail]) {
        if (serialized.includes(diagnostic)) continue;
        extraReads++; assert.ok(context.read(ref, { findText: diagnostic }).includes(diagnostic));
      }
      const warm = performance.now();
      for (let i = 0; i < 200; i++) context.project([message]);
      const warmMeanMs = (performance.now() - warm) / 200;
      const rawTokens = estimatedContextTokens([message]), previousTokens = estimatedContextTokens([boundedMessage(message)]), previewTokens = estimatedContextTokens(preview);
      assert.ok(previewTokens < previousTokens * 0.5, `${fixture.name}: token regression`);
      assert.ok(coldMs < 2000 && warmMeanMs < 20, 'local CPU/storage regression (generous CI threshold)');
      assert.equal(extraReads, 0, 'all required fixture diagnostics must remain in preview');
      return { fixture: fixture.name, rawTokens, previousTokens, previewTokens, savedVsPreviousPercent: Math.round(100 * (1 - previewTokens / previousTokens)),
        coldMs: Number(coldMs.toFixed(3)), warmMeanMs: Number(warmMeanMs.toFixed(4)), extraReads,
        zoomDescriptionBytes: Buffer.byteLength(memoryTools(() => { throw new Error('unused'); })[0].description), previousZoomDescriptionBytes: 719 };
    });
  } finally { removeDir(dir); }
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/context-benchmark.ts')) console.log(JSON.stringify(runContextBenchmark(), null, 2));
