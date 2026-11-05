import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// A literal NUL byte (a "\0" escape mangled by a shell or script) makes Git treat the
// file as binary: diffs, grep and reviews of it go blind.
test('tracked text sources contain no NUL byte', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'src', 'test', 'scripts'], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => /\.(ts|mjs|js|json|md)$/.test(f));
  assert.ok(files.length > 10);
  const bad = files.filter((f) => readFileSync(f).includes(0));
  assert.deepEqual(bad, []);
});
