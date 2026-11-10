import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync, rmdirSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'wake-reload-mutant-'));
try {
  for (const item of ['src', 'test', 'skills', 'assistant/src', 'package.json']) cpSync(join(root, item), join(dir, item), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
  const file = join(dir, 'src', 'index.ts');
  const source = readFileSync(file, 'utf8');
  const needle = 'wake && active && !fault && !stopping ? selfReload.ready(ctx, _event.aborted) : undefined';
  assert.equal(source.split(needle).length, 2, 'mutation must have exactly one target');
  writeFileSync(file, source.replace(needle, 'undefined'));
  const result = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', './test/support.ts', '--test', '--test-name-pattern=arbitrates reload \\(success\\)', 'test/wake-reload-arbitration.test.ts'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 1, `mutant did not fail normally: ${output}`);
  assert.match(output, /AssertionError[^]*an accepted reload must own the next continuation/, 'mutant must fail the arbitration assertion');
  console.log('Arbitration mutant killed by the real runtime assertion.');
} finally {
  const link = join(dir, 'node_modules');
  if (existsSync(link)) { if (process.platform === 'win32') rmdirSync(link); else unlinkSync(link); }
  rmSync(dir, { force: true, recursive: true });
}
