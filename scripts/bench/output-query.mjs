

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OutputStore } from '../../src/output-store.ts';
import { OutputContext } from '../../src/output-context.ts';
import { estimatedContextTokens } from '../../src/run-context.ts';

function tokenCount(text) {
  return estimatedContextTokens([{ role: 'toolResult', toolName: 'output_read', toolCallId: 'b', content: [{ type: 'text', text }], isError: false, timestamp: 0 }]);
}

const dir = mkdtempSync(join(tmpdir(), 'oc-bench-query-'));
try {
  const store = new OutputStore(dir, 'bench-query');
  const context = new OutputContext(store);

  const largeLog = Array.from({ length: 500 }, (_, i) =>
    i === 240 ? '2026-11-17T12:00:01Z ERROR auth_service: token validation failed (status=401)'
      : i === 412 ? '2026-11-17T12:01:05Z FAIL test/auth.test.ts: expected 200, got 401'
        : `2026-11-17T12:00:00Z INFO worker_pool: processed job_${i} in ${(i % 9) + 1}ms`,
  ).join('\n');

  const largeGhJson = JSON.stringify({
    repository: 'org/repo',
    runs: Array.from({ length: 120 }, (_, i) => ({
      databaseId: 800000 + i,
      name: 'CI Verify',
      status: 'completed',
      conclusion: i === 47 || i === 93 ? 'failure' : 'success',
      headBranch: `feat/task-${i}`,
      url: `https://github.com/org/repo/actions/runs/${800000 + i}`,
      logsSummary: `Ran 200 checks on commit ${i.toString(16).padStart(8, '0')}`,
    })),
  });

  const largeDiff = [
    ...Array.from({ length: 12 }, (_, f) => [
      `diff --git a/src/mod_${f}.ts b/src/mod_${f}.ts`,
      `--- a/src/mod_${f}.ts`,
      `+++ b/src/mod_${f}.ts`,
      '@@ -10,5 +10,8 @@ export function run() {',
      ...Array.from({ length: 20 }, (_, l) => `+  const step_${l} = ${l};`),
      '}',
    ].join('\n')),
  ].join('\n');

  const cases = [
    {
      name: 'large-ci-log-grep',
      raw: largeLog,
      query: { kind: 'grep', pattern: 'ERROR|FAIL', context: 1 },
    },
    {
      name: 'large-gh-json-filter',
      raw: largeGhJson,
      query: { kind: 'json', path: '$.runs', filter: { field: 'conclusion', equals: 'failure' }, fields: ['databaseId', 'headBranch', 'conclusion'] },
    },
    {
      name: 'large-gh-json-outline',
      raw: largeGhJson,
      query: { kind: 'outline', maxDepth: 3 },
    },
    {
      name: 'large-diff-outline',
      raw: largeDiff,
      query: { kind: 'outline' },
    },
  ];

  let totalBaselineTokens = 0;
  let totalQueryTokens = 0;

  const fixtures = cases.map(item => {
    const ref = store.put(item.raw);
    const baselineText = context.read(ref, { offset: 0, limit: 25000 });
    const queryText = context.read(ref, { query: item.query });
    const baselineBytes = Buffer.byteLength(baselineText);
    const queryBytes = Buffer.byteLength(queryText);
    const baselineTokens = tokenCount(baselineText);
    const queryTokens = tokenCount(queryText);
    totalBaselineTokens += baselineTokens;
    totalQueryTokens += queryTokens;
    return {
      name: item.name,
      baselineBytes,
      queryBytes,
      baselineTokens,
      queryTokens,
      savedTokensPercent: Number((100 * (1 - queryTokens / baselineTokens)).toFixed(1)),
    };
  });

  console.log(JSON.stringify({
    metric: 'output_query_inspection_tokens',
    value: totalQueryTokens,
    unit: 'tokens',
    lowerIsBetter: true,
    totalBaselineTokens,
    totalQueryTokens,
    savedTokensPercent: Number((100 * (1 - totalQueryTokens / totalBaselineTokens)).toFixed(2)),
    fixtures,
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
