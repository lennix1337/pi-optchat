// Mutation proof uses generated disposable copies. Never edits the working source.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sourcePath = fileURLToPath(new URL('../src/authorization.ts', import.meta.url));
const diagnostic = new URL('../src/operation-diagnostics.ts', import.meta.url).href;
const source = readFileSync(sourcePath, 'utf8').replace("'./operation-diagnostics.ts'", JSON.stringify(diagnostic));
const root = mkdtempSync(join(tmpdir(), 'effect-approval-mutations-'));
const driver = `import assert from 'node:assert/strict';
import { EffectApprovals } from './subject.ts';
const gate = new EffectApprovals();
const call = {session:'owner',cwd:'/repo',tool:'bash',input:{command:'git push origin main'}};
const pending = gate.admit(call);
assert.equal(pending?.block,true,'unapproved invocation must be blocked');
const text = 'approve-effect '+pending.token;
assert.notEqual(gate.approve('owner','extension',text),'approved','hidden input cannot approve');
assert.notEqual(gate.approve('other','interactive',text),'approved','foreign session cannot approve');
assert.equal(gate.approve('owner','interactive',text),'approved');
assert.equal(gate.admit(call),undefined);
assert.equal(gate.admit(call)?.block,true,'approval must be consumed once');
`;
const mutations = [
  ['provenance', "if (source !== 'interactive') return 'ignored';", ''],
  ['owner', 'entry.session !== session', 'false'],
  ['one-shot', 'this.pending.delete(token); return;', 'return;'],
  ['admission', '    if (diagnostic(call)) return;', '    return;'],
];
const outcomes = [];
function run(name, contents) {
  const dir = join(root, name); mkdirSync(dir);
  writeFileSync(join(dir, 'subject.ts'), contents);
  writeFileSync(join(dir, 'probe.mjs'), driver);
  const result = spawnSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  const log = result.stdout + result.stderr;
  writeFileSync(join(dir, 'output.log'), log);
  return { name, status: result.status, assertionFailure: /AssertionError/.test(log), moduleFailure: /ERR_MODULE_NOT_FOUND|SyntaxError/.test(log) };
}
const baseline = run('baseline', source);
assert.equal(baseline.status, 0, JSON.stringify({ baseline, root }));
for (const [name, from, to] of mutations) {
  assert.equal(source.split(from).length, 2, `mutation anchor must be unique: ${name}`);
  const result = run(name, source.replace(from, to));
  assert.notEqual(result.status, 0, `guard mutation must fail: ${name}`);
  assert.equal(result.assertionFailure, true, JSON.stringify(result));
  assert.equal(result.moduleFailure, false, JSON.stringify(result));
  outcomes.push(result);
}
assert.equal(readFileSync(sourcePath, 'utf8').replace("'./operation-diagnostics.ts'", JSON.stringify(diagnostic)), source, 'working source bytes preserved');
writeFileSync(join(root, 'result.json'), JSON.stringify({ baseline, mutations: outcomes, sourceUnchanged: true }, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, mutationsKilled: outcomes.length, sourceUnchanged: true, receipt: pathToFileURL(root).href }));
