import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewOutput } from '../src/output-preview.ts';

const savings = (preview: ReturnType<typeof previewOutput>) =>
  Math.round((1 - preview.previewBytes / preview.originalBytes) * 100);

test('large previews avoid full-size mapped index arrays while retaining edge diagnostics', () => {
  const lines = Array.from({ length: 4000 }, (_, i) => `Compiling synthetic module ${i}`);
  lines[0] = 'warning: first diagnostic';
  lines[3999] = 'error: last diagnostic';
  const text = lines.join('\n');
  let mappedLines = 0;
  const map = Array.prototype.map, flatMap = Array.prototype.flatMap;

  Array.prototype.map = function (this: unknown[], ...args) {
    if (this.length >= lines.length) mappedLines += this.length;
    return Reflect.apply(map, this, args);
  };
  Array.prototype.flatMap = function (this: unknown[], ...args) {
    if (this.length >= lines.length) mappedLines += this.length;
    return Reflect.apply(flatMap, this, args);
  };
  let preview: ReturnType<typeof previewOutput>;
  try { preview = previewOutput(text); }
  finally { Array.prototype.map = map; Array.prototype.flatMap = flatMap; }
  assert.equal(mappedLines, 0, 'line sampling must not map the whole source into temporary index arrays');
  assert.equal(preview.format, 'build/log');
  assert.equal(preview.diagnosticMatches, 2);
  assert.match(preview.text, /1: warning: first diagnostic/);
  assert.match(preview.text, /4000: error: last diagnostic/);
  assert.equal(preview.omittedLines, 3980);
});

test('JSON preview surfaces diagnostic fields and reports measured byte savings', () => {
  const original = JSON.stringify({
    status: 'failed',
    exitCode: 2,
    error: 'CS0246: missing generated type',
    results: Array.from({ length: 180 }, (_, index) => ({ id: index, payload: 'irrelevant '.repeat(10) })),
  });
  const preview = previewOutput(original);

  assert.equal(preview.format, 'json');
  assert.equal(preview.useful, true);
  assert.match(preview.text, /\$\.status = "failed"/);
  assert.match(preview.text, /\$\.exitCode = 2/);
  assert.match(preview.text, /CS0246: missing generated type/);
  assert.match(preview.text, /JSON fields omitted/);
  assert.ok(preview.omittedFields > 0);
  assert.ok(savings(preview) >= 80, `expected ≥80% bytes saved, got ${savings(preview)}%`);
  assert.match(preview.text, /Retrieve\/search the original/);
});

test('diff preview keeps file and hunk boundaries, changed lines, and diagnostic evidence', () => {
  const original = [
    'diff --git a/src/engine.rs b/src/engine.rs',
    'index 123..456 100644',
    '--- a/src/engine.rs',
    '+++ b/src/engine.rs',
    '@@ -1,2 +1,2 @@',
    ...Array.from({ length: 70 }, (_, index) => `${index % 2 ? '+' : '-'}${index === 0 ? 'error CS0246: generated type missing' : `changed_${index} ${'detail '.repeat(18)}`}`),
    'exit code: 1',
  ].join('\n');
  const preview = previewOutput(original);

  assert.equal(preview.format, 'diff');
  assert.match(preview.text, /diff --git a\/src\/engine.rs/);
  assert.match(preview.text, /@@ -1,2 \+1,2 @@/);
  assert.match(preview.text, /error CS0246: generated type missing/);
  assert.match(preview.text, /exit code: 1/);
  assert.ok(preview.omittedLines > 0);
  assert.ok(savings(preview) > 50, `expected useful byte reduction, got ${savings(preview)}%`);
});

test('unified diff without git metadata is detected conservatively', () => {
  const preview = previewOutput(['--- before.txt', '+++ after.txt', '@@ -1 +1 @@', '-before', '+after'].join('\n'));
  assert.equal(preview.format, 'diff');
  assert.match(preview.text, /@@ -1 \+1 @@/);
  assert.match(preview.text, /\+after/);
});

test('search preview retains match locations, summary, and errors across a large result set', () => {
  const original = [
    ...Array.from({ length: 90 }, (_, index) => `src/file${index % 4}.ts:${index + 1}:${index === 44 ? 'error: missing export' : `match_${index} ${'context '.repeat(12)}`}`),
    '90 matches in 4 files',
  ].join('\n');
  const preview = previewOutput(original);

  assert.equal(preview.format, 'search');
  assert.match(preview.text, /src\/file0\.ts \(23 matches\):/);
  assert.match(preview.text, /1: match_0/);
  assert.match(preview.text, /src\/file1\.ts \(23 matches\):/);
  assert.match(preview.text, /90: match_89/);
  assert.match(preview.text, /90 matches in 4 files/);
  assert.match(preview.text, /error: missing export/);
  assert.ok(preview.omittedLines > 0);
  assert.ok(savings(preview) > 50);
});

test('build-log preview preserves first/last diagnostics and explicit exit evidence', () => {
  const original = [
    ...Array.from({ length: 100 }, (_, index) => index === 37
      ? `warning TS1234: ${'large context '.repeat(30)}`
      : `build line ${index} ${'output '.repeat(15)}`),
    'Tests: 1 failed, 99 passed',
    'exit code: 1',
  ].join('\n');
  const preview = previewOutput(original);

  assert.equal(preview.format, 'build/log');
  assert.match(preview.text, /warning TS1234/);
  assert.match(preview.text, /1 failed, 99 passed/);
  assert.match(preview.text, /exit code: 1/);
  assert.match(preview.text, /diagnostic-pattern matches, not a verdict/);
  assert.ok(preview.omittedLines > 0);
  assert.ok(savings(preview) > 50);
});

test('unparseable or oversized single-line blobs are not projected as useful previews', () => {
  const invalidJson = previewOutput('{"truncated":');
  const opaque = previewOutput('x'.repeat(20_000));

  assert.equal(invalidJson.useful, false);
  assert.equal(opaque.useful, false);
  assert.equal(previewOutput(`{"payload":"${'x'.repeat(1_100_000)}"}`).useful, false);
});

test('long numeric bash output stays within the 200 ms event-loop budget', () => {
  const text = `${'1'.repeat(45_000)}\n[Showing last 50KB of output]`;
  const started = performance.now();
  const preview = previewOutput(text);
  const elapsed = performance.now() - started;
  assert.equal(preview.format, 'build/log');
  assert.ok(elapsed < 200, `numeric output preview blocked the event loop for ${elapsed.toFixed(1)} ms`);
  assert.equal(previewOutput('prefix\n123 matches in 4 files').format, 'search');
});

test('clipped diagnostic lines retain evidence near the end of long lines', () => {
  const preview = previewOutput(`${'context '.repeat(80)}exit code: 17`);
  assert.match(preview.text, /exit code: 17/);
  assert.match(preview.text, /line clipped/);
  assert.equal(preview.useful, true);
});

test('JSON array tabulation shows head, tail, and middle outliers past 40 rows', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({
    id: i,
    state: i === 28 ? 'FAILED' : 'MERGED',
    title: i === 28 ? 'fix: critical auth error' : `chore: routine update ${i}`,
    author: { login: `dev-${i % 3}` },
  }));
  const preview = previewOutput(JSON.stringify(items, null, 2));
  assert.equal(preview.format, 'json');
  assert.equal(preview.useful, true);
  assert.match(preview.text, /JSON table \$ \(60 rows/);
  assert.match(preview.text, /\[0\]/);
  assert.match(preview.text, /\[28\]\*.*FAILED.*critical auth error/);
  assert.match(preview.text, /\[59\]/);
  assert.match(preview.text, /rows omitted; 1 outliers shown/);
  assert.ok(savings(preview) >= 60);
});

test('unified diff collapses lockfile sections to +A/-B while preserving code hunks', () => {
  const diff = [
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1,4 +1,5 @@',
    '-    "version": "1.0.0"',
    '-    "old": true',
    '+    "version": "1.0.1"',
    '+    "new": true',
    '+    "extra": 1',
    'diff --git a/src/auth.ts b/src/auth.ts',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -10,2 +10,2 @@',
    '-return false;',
    '+return true;',
  ].join('\n');
  const preview = previewOutput(diff);
  assert.equal(preview.format, 'diff');
  assert.match(preview.text, /\[lockfile collapsed: package-lock\.json \(\+3\/-2 lines\)\]/);
  assert.match(preview.text, /diff --git a\/src\/auth\.ts/);
  assert.match(preview.text, /\+return true;/);
});

test('HTML preview strips scripts/styles/tags and decodes entities to plain text', () => {
  const html = [
    '<!DOCTYPE html><html><head><title>502 &amp; Timeout</title>',
    '<style>body{color:red}</style>',
    `<script>var secret = "${'x'.repeat(3000)}";</script>`,
    '</head><body><h1>Bad Gateway</h1><p>Upstream error: connection refused.</p></body></html>',
  ].join('\n');
  const preview = previewOutput(html);
  assert.equal(preview.format, 'html');
  assert.equal(preview.useful, true);
  assert.match(preview.text, /Title: 502 & Timeout/);
  assert.match(preview.text, /Bad Gateway/);
  assert.match(preview.text, /Upstream error: connection refused/);
  assert.ok(!preview.text.includes('var secret'));
  assert.ok(!preview.text.includes('color:red'));
  assert.ok(savings(preview) >= 70);
});
