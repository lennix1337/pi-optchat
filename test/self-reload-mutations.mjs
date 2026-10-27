// Mutation evidence uses generated copies only. The live checkout is never patched.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const repo = fileURLToPath(new URL('..', import.meta.url));
const file = join(repo, 'src/self-reload.ts'), original = readFileSync(file, 'utf8');
const mutations = [
  ['owner', 't.cwd === ctx.cwd && t.session === ctx.sessionManager.getSessionId()', 'true'],
  ['busy', 'if (current.blocked) return current.blocked;', ''],
  ['queue', "if (ctx.hasPendingMessages()) return 'Queued messages must be delivered first.';", ''],
  ['abort', 'const reason = event.aborted || runFailed(ctx) ?', 'const reason = false ?'],
  ['readiness', "&& !subagentsAnswered)", '&& false)'],
  ['completion', 'if (lease.completed) lease.resume();', 'lease.resume();'],
];
const root = mkdtempSync(join(tmpdir(), 'self-reload-mutations-')), outcomes = [];
for (const [name, anchor, replacement] of [['baseline', '', ''], ...mutations]) {
  if (anchor) assert.equal(original.split(anchor).length, 2, `unique mutation anchor: ${name}`);
  const cwd = join(root, name); mkdirSync(join(cwd, 'src'), { recursive: true }); mkdirSync(join(cwd, 'test'));
  for (const entry of ['package.json', 'test/support.ts', 'test/self-reload.test.ts']) cpSync(join(repo, entry), join(cwd, entry));
  symlinkSync(join(repo, 'node_modules'), join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(cwd, 'src/self-reload.ts'), anchor ? original.replace(anchor, replacement) : original);
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--import', './test/support.ts', '--test', 'test/self-reload.test.ts'], { cwd, encoding: 'utf8', timeout: 15000 });
  if (run.error || run.signal) throw run.error ?? new Error(`Mutation ${name} interrupted: ${run.signal}`);
  const log = run.stdout + run.stderr; writeFileSync(join(cwd, 'output.log'), log);
  if (name === 'baseline') assert.equal(run.status, 0, log);
  else { assert.notEqual(run.status, 0, `Guard removal must fail: ${name}`); assert.match(log, /AssertionError/); assert.doesNotMatch(log, /ERR_MODULE_NOT_FOUND|SyntaxError/); }
  outcomes.push({ name, exitCode: run.status });
}
assert.equal(readFileSync(file, 'utf8'), original);
console.log(JSON.stringify({ passed: true, outcomes, sourceUnchanged: true, evidence: root }));
