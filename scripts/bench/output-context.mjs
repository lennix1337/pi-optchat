

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OutputStore } from '../../src/output-store.ts';
import { OutputContext } from '../../src/output-context.ts';
import { estimatedContextTokens } from '../../src/run-context.ts';

function buildCorpus() {
  const npmVerify = [
    '> pi-optchat@0.8.4 verify',
    '> node scripts/verify.mjs',
    ...Array.from({ length: 180 }, (_, i) => `✔ test/suite-${String(i).padStart(3, '0')}.test.ts > case ${i} passed (${(i % 17) + 2}.4ms)`),
    '✖ test/suite-091.test.ts > regression guard failed (14.2ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 200 !== 403',
    ...Array.from({ length: 40 }, (_, i) => `✔ test/tail-${String(i).padStart(2, '0')}.test.ts > case ${i} passed (3.1ms)`),
    'ℹ tests 221',
    'ℹ pass 220',
    'ℹ fail 1',
    'exit code 1',
  ].join('\n');

  const ghPrList = JSON.stringify(
    Array.from({ length: 55 }, (_, i) => ({
      number: 1000 + i,
      title: i === 27 ? 'fix: handle error on empty auth state' : `chore: update module ${i} configuration and tests`,
      state: i === 27 ? 'OPEN' : 'MERGED',
      mergeable: i === 27 ? 'CONFLICTING' : 'MERGEABLE',
      author: { login: `dev-${i % 6}` },
      headRefName: `feat/item-${i}`,
      updatedAt: `2026-11-${String((i % 28) + 1).padStart(2, '0')}T12:00:00Z`,
    })),
    null,
    2,
  );

  const ghRunSmall = JSON.stringify(
    Array.from({ length: 18 }, (_, i) => ({
      databaseId: 900000 + i,
      name: 'CI Verify',
      status: 'completed',
      conclusion: i === 9 ? 'failure' : 'success',
      headBranch: `feat/branch-${i}`,
      createdAt: `2026-11-17T${String(i % 24).padStart(2, '0')}:10:00Z`,
    })),
    null,
    2,
  );

  const lockfileDiff = [
    'diff --git a/package-lock.json b/package-lock.json',
    'index 1111111..2222222 100644',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -100,6 +100,180 @@',
    ...Array.from({ length: 120 }, (_, i) => `-${' '.repeat(6)}"resolved": "https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.0.0.tgz",`),
    ...Array.from({ length: 140 }, (_, i) => `+${' '.repeat(6)}"resolved": "https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.0.1.tgz",`),
    'diff --git a/src/service.ts b/src/service.ts',
    'index 3333333..4444444 100644',
    '--- a/src/service.ts',
    '+++ b/src/service.ts',
    '@@ -12,4 +12,6 @@ export function handleRequest(id: string) {',
    '   if (!id) throw new Error("missing id");',
    '-  return loadLegacy(id);',
    '+  return loadCurrent(id);',
    ' }',
  ].join('\n');

  const htmlPage = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>502 Bad Gateway - Upstream Timeout</title>',
    '  <style>body { font-family: sans-serif; margin: 40px; } .nav { display: flex; } .hidden { display: none; }</style>',
    '  <script>window.__DATA__ = { token: "anon", items: [' + Array.from({ length: 80 }, (_, i) => `"item_${i}"`).join(',') + '] };</script>',
    '</head>',
    '<body>',
    '  <nav class="nav">' + Array.from({ length: 25 }, (_, i) => `<a href="/p/${i}">Nav Item ${i}</a>`).join(' ') + '</nav>',
    '  <main>',
    '    <h1>502 Bad Gateway</h1>',
    '    <p>Error: upstream service timed out after 30000ms while fetching /api/v1/status.</p>',
    '    <p>Request ID: req_anon_001234</p>',
    '  </main>',
    '</body>',
    '</html>',
  ].join('\n');

  const grepHits = [
    ...Array.from({ length: 60 }, (_, i) => `src/module${i % 5}.ts:${i + 10}:${i === 33 ? 'error: invalid token handler' : `const value_${i} = computeThing(arg_${i});`}`),
    '60 matches in 5 files',
  ].join('\n');

  return [
    { name: 'npm-verify-log', toolName: 'bash', isError: true, text: npmVerify },
    { name: 'gh-pr-list-json', toolName: 'bash', isError: false, text: ghPrList },
    { name: 'gh-run-small-json', toolName: 'bash', isError: false, text: ghRunSmall },
    { name: 'unified-diff-lockfile', toolName: 'bash', isError: false, text: lockfileDiff },
    { name: 'html-error-page', toolName: 'bash', isError: true, text: htmlPage },
    { name: 'grep-grouped', toolName: 'bash', isError: false, text: grepHits },
  ];
}

const dir = mkdtempSync(join(tmpdir(), 'oc-bench-context-'));
try {
  const store = new OutputStore(dir, 'bench-session');
  const context = new OutputContext(store);
  const corpus = buildCorpus();

  let totalRawBytes = 0;
  let totalProjectedBytes = 0;
  let totalRawTokens = 0;
  let totalProjectedTokens = 0;

  const fixtures = corpus.map((item, idx) => {
    const message = {
      role: 'toolResult',
      toolName: item.toolName,
      toolCallId: `call_${idx}`,
      content: [{ type: 'text', text: item.text }],
      isError: item.isError,
      timestamp: idx,
    };
    const [projected] = context.project([message]);
    const rawBytes = Buffer.byteLength(item.text);
    const projectedText = projected.content[0].text;
    const projectedBytes = Buffer.byteLength(projectedText);
    const rawTokens = estimatedContextTokens([message]);
    const projectedTokens = estimatedContextTokens([projected]);

    totalRawBytes += rawBytes;
    totalProjectedBytes += projectedBytes;
    totalRawTokens += rawTokens;
    totalProjectedTokens += projectedTokens;

    return {
      name: item.name,
      rawBytes,
      projectedBytes,
      rawTokens,
      projectedTokens,
      savedTokensPercent: Number((100 * (1 - projectedTokens / rawTokens)).toFixed(1)),
    };
  });

  const savedTokensPercent = Number((100 * (1 - totalProjectedTokens / totalRawTokens)).toFixed(2));
  console.log(JSON.stringify({
    metric: 'output_context_projected_tokens',
    value: totalProjectedTokens,
    unit: 'tokens',
    lowerIsBetter: true,
    totalRawBytes,
    totalProjectedBytes,
    totalRawTokens,
    totalProjectedTokens,
    savedBytesPercent: Number((100 * (1 - totalProjectedBytes / totalRawBytes)).toFixed(2)),
    savedTokensPercent,
    fixtures,
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
