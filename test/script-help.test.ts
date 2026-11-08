import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const scripts = ['delegation-stats', 'foreign-id-rate', 'tool-batching-stats'];

for (const name of scripts) {
  test(`${name} --help prints the usage on stdout and exits 0, with no stack trace`, () => {
    const run = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', `scripts/${name}.mjs`, '--help'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`usage: ${name}\\.mjs`, 'i'));
    assert.equal(run.stderr, '');
  });
}

test('delegation-stats without a sessions dir exits 2 with the usage line, not a stack trace', () => {
  const run = spawnSync(process.execPath, ['scripts/delegation-stats.mjs'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^usage: delegation-stats\.mjs/);
  assert.doesNotMatch(run.stderr, /at .*\.mjs:\d+/);
});

test('repair-ai-memory --help prints the usage on stdout and exits 0, with no stack trace', () => {
  const run = spawnSync(process.execPath, ['scripts/repair-ai-memory.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^usage: .*repair-ai-memory\.mjs/i);
  assert.equal(run.stderr, '');
});

test('assistant-checks --help prints the usage and exits 0 without running any check', () => {
  const run = spawnSync(process.execPath, ['scripts/assistant-checks.mjs', '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0, `${run.error?.message ?? ''}${run.stderr}`);
  assert.match(run.stdout, /^usage: assistant-checks\.mjs/i);
  assert.doesNotMatch(run.stdout, /=== assistant-/);
});
