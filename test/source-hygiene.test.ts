import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// external: Git treats files containing literal NUL bytes as binary.

test('tracked text sources contain no NUL byte', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'src', 'test', 'scripts'], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => /\.(ts|mjs|js|json|md)$/.test(f));
  assert.ok(files.length > 10);
  const bad = files.filter((f) => readFileSync(f).includes(0));
  assert.deepEqual(bad, []);
});
