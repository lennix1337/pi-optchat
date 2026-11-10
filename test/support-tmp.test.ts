import './support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Git Bash mounts /tmp on TMP (before TEMP) in the first process that starts it, and shells alive at the same time share that mount.
// A test file's shell must therefore never see a TMP that goes away with the file: it would leave /tmp dangling for the files that run next to it.
test('a test process keeps tmpdir() on its own root and TMP on the outermost root, which outlives it', () => {
  const code = `console.log(JSON.stringify({ temp: process.env.TEMP, tmp: process.env.TMP, tmpdir: require('node:os').tmpdir() }))`;
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', pathToFileURL(join(import.meta.dirname, 'support.ts')).href, '-e', code], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const seen = JSON.parse(child.stdout) as { temp: string; tmp: string; tmpdir: string };
  assert.equal(seen.tmp, process.env.TMP, 'the child shares the TMP of the process that started it');
  assert.equal(seen.tmpdir, seen.temp, 'node reads TEMP, so its temp folders stay in the child\'s own root');
  assert.ok(seen.temp.startsWith(tmpdir()) && seen.temp !== tmpdir(), 'the child root is nested in its parent\'s');
  assert.equal(existsSync(seen.temp), false, 'the child removed its own root when it ended');
  assert.equal(existsSync(seen.tmp), true, 'the shared TMP is still there for the files that run after it');
});
