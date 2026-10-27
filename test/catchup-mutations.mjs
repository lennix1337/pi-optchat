// Generated disposable copies keep mutation proof away from the working sources.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = join(repo, 'src', 'catchup-integration.ts');
const original = readFileSync(sourcePath, 'utf8');
const anchor = "event.source !== 'interactive' || ctx.mode !== 'tui' || ";
assert.equal(original.split(anchor).length, 2, 'provenance guard anchor must be unique');
const root = mkdtempSync(join(tmpdir(), 'catchup-mutations-'));
const outcomes = [];
for (const [name, source] of [['baseline', original], ['provenance-removed', original.replace(anchor, '')]]) {
  const cwd = join(root, name);
  mkdirSync(join(cwd, 'test'), { recursive: true });
  cpSync(join(repo, 'src'), join(cwd, 'src'), { recursive: true });
  cpSync(join(repo, 'package.json'), join(cwd, 'package.json'));
  for (const file of ['support.ts', 'catchup-integration.test.ts']) cpSync(join(repo, 'test', file), join(cwd, 'test', file));
  symlinkSync(join(repo, 'node_modules'), join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(cwd, 'src', 'catchup-integration.ts'), source);
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--import', './test/support.ts', '--test', 'test/catchup-integration.test.ts'], { cwd, encoding: 'utf8', timeout: 20000 });
  if (run.error) throw run.error;
  const log = run.stdout + run.stderr;
  writeFileSync(join(cwd, 'output.log'), log);
  if (name === 'baseline') assert.equal(run.status, 0, log);
  else {
    assert.notEqual(run.status, 0, 'removing provenance must fail the receipt assertions');
    assert.match(log, /AssertionError/);
    assert.doesNotMatch(log, /ERR_MODULE_NOT_FOUND|SyntaxError/);
  }
  outcomes.push({ name, exitCode: run.status });
}
assert.equal(readFileSync(sourcePath, 'utf8'), original, 'working source bytes must stay unchanged');
const result = { passed: true, outcomes, sourceUnchanged: true, receipt: root };
writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
