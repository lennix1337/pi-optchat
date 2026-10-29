import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateDirectory } from '../src/store/private-directory.ts';
import { DisplayLearning, displayBinding } from '../src/memory/display-learning.ts';

test('CLI reads bounded candidate from stdin and rejects nonterminal mutations', { timeout: 120000 }, () => {
  const dir = join(tmpdir(), `display-cli-${randomUUID()}`); createPrivateDirectory(dir);
  const config = join(dir, 'config.json'); const db = join(dir, 'learning-display.sqlite');
  writeFileSync(config, JSON.stringify({ version: 1, profileId: 'fixture-profile', databasePath: join(dir, 'tasks.sqlite'), endpoint: 'http://127.0.0.1:34567', token: randomUUID() }));
  const run = (args: string[], input = '') => spawnSync(process.execPath, [process.env.DISPLAY_LEARNING_TEST_CLI ?? 'assistant/scripts/display-learning.mjs', config, ...args], { input, encoding: 'utf8', timeout: 30000 });
  let learning: DisplayLearning | undefined;
  try {
    const candidate = 'dashboard status task in progress completed tasks';
    const proposed = run(['propose'], candidate); assert.equal(proposed.status, 0, proposed.stderr); assert.ok(!proposed.stdout.includes(candidate));
    const { binding } = JSON.parse(proposed.stdout) as { binding: { id: string; version: number; profileId: string } };
    assert.equal(binding.profileId, 'fixture-profile');
    const shown = run(['show', binding.id, String(binding.version)]); assert.equal(shown.status, 0, shown.stderr); assert.equal(JSON.parse(shown.stdout).proposal.profileId, 'fixture-profile');
    const forbiddenArg = run(['propose', 'private text']); assert.notEqual(forbiddenArg.status, 0); assert.match(forbiddenArg.stderr, /candidate_must_use_stdin/);
    const oversized = run(['propose'], 'x'.repeat(1025)); assert.notEqual(oversized.status, 0); assert.match(oversized.stderr, /candidate_too_large/);
    const measured = run(['measure', binding.id, String(binding.version)]); assert.equal(measured.status, 0, measured.stderr); assert.ok(!measured.stdout.includes(candidate));
    for (const action of ['approve', 'reject', 'apply', 'revert']) {
      const result = run([action, binding.id, String(binding.version)], `${action} ${binding.id} ${binding.version}\n`);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /interactive_terminal_required/);
    }
    const authority = {}; learning = new DisplayLearning({ databasePath: db, profileId: 'fixture-profile', operatorAuthority: authority });
    const p = learning.get(binding.id, binding.version); assert.equal(p.state, 'measured'); assert.equal(displayBinding(p).profileId, 'fixture-profile');
  } finally { learning?.close(); rmSync(dir, { recursive: true, force: true }); }
});
