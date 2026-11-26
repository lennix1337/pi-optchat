import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('the hang reporter only names the file still held open after its tests finish', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hang-'));
  writeFileSync(join(dir, 'fine.test.mjs'), "import {test} from 'node:test'; test('a', () => {});\n");
  writeFileSync(
    join(dir, 'leaky.test.mjs'),
    "import {test} from 'node:test'; test('b', () => {}); setTimeout(() => {}, 3000);\n",
  );
  const env: NodeJS.ProcessEnv = { ...process.env, HANG_REPORT_MS: '1500' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [
    '--test',
    '--test-reporter=tap', '--test-reporter-destination=stdout',
    '--test-reporter=' + join(import.meta.dirname, '../scripts/ci-hang-reporter.mjs'), '--test-reporter-destination=stderr',
    join(dir, 'fine.test.mjs'), join(dir, 'leaky.test.mjs'),
  ], { encoding: 'utf8', timeout: 8000, env });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^TAP version /);
  assert.match(r.stderr, /HANG-REPORT/);
  assert.match(r.stderr, /leaky\.test\.mjs/);
  assert.doesNotMatch(r.stderr, /fine\.test\.mjs/);
});
