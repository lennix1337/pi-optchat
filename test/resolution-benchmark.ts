// Deterministic retrieval-policy replay, NOT an LLM quality or provider-cache benchmark.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Focus } from '../src/focus.ts';
import { Memory, PAGE } from '../src/memory.ts';
import { memoryTools } from '../src/tools.ts';
import { buildContext, textContent } from '../src/transcript.ts';
import { estimatedContextTokens } from '../src/run-context.ts';
import { removeDir } from './support.ts';

const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
const timings = (run: () => unknown) => {
  for (let i = 0; i < 10; i++) run();
  const samples = Array.from({ length: 100 }, () => { const at = performance.now(); run(); return performance.now() - at; });
  return { medianMs: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), samples: samples.length };
};
const commonPrefix = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

export async function runResolutionBenchmark() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-resolution-'));
  const memory = new Memory(dir, async input => input.source.includes('GXE-FOCUS') ? 'GXE-FOCUS: scoped permission, originals contain exact constraints.' : 'Unrelated project history.', () => {}, 2500);
  const focus = new Focus();
  const [zoom] = memoryTools(() => memory, undefined, ref => focus.observe(ref));
  let baselineCalls = 0, baselineBytes = 0;
  const plainZoom = (id: number, n = 1) => { const text = memory.zoom(id, n); baselineCalls++; baselineBytes += Buffer.byteLength(text); return text; };
  try {
    for (let i = 0; i < 64; i++) memory.append('user', i === 17
      ? `${'Synthetic old build detail. '.repeat(400)}\nGXE-FOCUS: disposable KBTeste only; no Cloud, no publishing.\n${'More synthetic detail. '.repeat(400)}`
      : `Unrelated topic ${i}: ${'detail '.repeat(80)}`);
    await memory.settle(AbortSignal.timeout(10000), 'tree');
    const originalView = memory.render(), originalText = memory.root.map(entry => entry.text);
    // Baseline: deterministic marker-guided tree descent. This measures tool plumbing, not model branch choices.
    let id = 0, n = 64;
    while (n > 1) {
      const lines = plainZoom(id, n).split('\n');
      const hit = lines.find(line => line.includes('GXE-FOCUS'));
      assert.ok(hit, 'fixture landmark must remain navigable');
      const match = /^(\d+)\+(\d+)\|/.exec(hit)!;
      id = Number(match[1]); n = Number(match[2]);
    }
    assert.equal(id, 17);
    const baselineOriginal = plainZoom(id);
    assert.ok(baselineOriginal.includes('disposable KBTeste only'));
    const treeBaseline = { toolCalls: baselineCalls, returnedBytes: baselineBytes };

    // Candidate reads only the selected known branch. A second call opens the exact original passage.
    const targeted = await zoom.execute('find', { id: 0, n: 64, findText: 'GXE-FOCUS' });
    const targetedText = textContent(targeted.content);
    assert.ok(targetedText.includes('GXE-FOCUS'));
    const at = memory.root[17].text.indexOf('GXE-FOCUS');
    const exact = await zoom.execute('original', { id: 17, n: 1, offset: at, limit: 500 });
    assert.ok(textContent(exact.content).includes('disposable KBTeste only'));
    const targetedLookup = { toolCalls: 2, returnedBytes: Buffer.byteLength(targetedText) + Buffer.byteLength(textContent(exact.content)) };

    const task = [{ role: 'user' as const, content: 'Resume GXE-FOCUS without changing its authorization.', timestamp: 1 }];
    let baselineRepeatBytes = 0, focusedRepeatBytes = 0;
    const roundtrips = 4;
    for (let turn = 0; turn < roundtrips; turn++) {
      // Same known original in both policies; candidate retains only the successful page reference.
      baselineRepeatBytes += Buffer.byteLength(memory.zoom(17, 1));
      const detail = focus.render(memory);
      assert.ok(detail.includes('disposable KBTeste only'));
      focusedRepeatBytes += Buffer.byteLength(detail);
      const request = buildContext([], task, originalView, 'shared system', [], undefined, undefined, detail);
      assert.ok(JSON.stringify(request).includes('disposable KBTeste only'));
    }
    const reuse = { boundaries: roundtrips, baseline: { extraToolCalls: roundtrips, detailBytes: baselineRepeatBytes },
      focused: { extraToolCalls: 0, detailBytes: focusedRepeatBytes } };
    assert.ok(focusedRepeatBytes < baselineRepeatBytes);

    // The focus can expose an old grant; the current correction and chronological order must stay present.
    const revoked = { role: 'user' as const, content: 'Correction: GXE-FOCUS permission revoked; read-only discussion now.', timestamp: 2 };
    const request = buildContext([], [...task, revoked], originalView, 'shared system', [], undefined, undefined, focus.render(memory));
    assert.ok(JSON.stringify(request).includes(revoked.content));
    const first = JSON.stringify(buildContext([], task, originalView, 'shared system', [], undefined, undefined, focus.render(memory)));
    focus.observe({ id: 18, n: 1, limit: 200 });
    const second = JSON.stringify(buildContext([], task, originalView, 'shared system', [], undefined, undefined, focus.render(memory)));
    assert.equal(memory.render(), originalView, 'working focus must never mutate chronological tree');
    assert.deepEqual(memory.root.map(entry => entry.text), originalText);
    return {
      kind: 'offline deterministic policy replay', baseline: '62bb6c0 tree/zoom semantics; no focus', providerCalls: 0,
      fixtures: { oldTopic: { baseline: treeBaseline, targeted: targetedLookup }, repeatedRefresh: reuse,
        revokedDecision: { oldEvidenceRecoverable: true, currentCorrectionPreserved: true, modelComplianceMeasured: false } },
      localOverhead: { focusRender: timings(() => focus.render(memory)), originalZoom: timings(() => memory.zoom(17, 1)),
        contextAssembly: timings(() => buildContext([], task, originalView, 'shared system', [], undefined, undefined, focus.render(memory))) },
      cacheEligibility: { commonPrefixBytes: Buffer.byteLength(first.slice(0, commonPrefix(first, second))), chronologicalViewBytes: Buffer.byteLength(originalView),
        providerCacheHitsMeasured: false },
      focusedRequestEstimatedTokens: estimatedContextTokens(request), pageCeiling: PAGE,
      limitations: ['Scripted fixture summaries and scripted navigation, not model reasoning.', 'No claims about summary fidelity, real cache hit rates, billed cost or whole-agent speed.'],
    };
  } finally { await memory.close(); removeDir(dir); }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/resolution-benchmark.ts')) console.log(JSON.stringify(await runResolutionBenchmark(), null, 2));
