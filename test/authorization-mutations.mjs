// Mutation proof uses generated disposable copies. Never edits the working source.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sourcePath = fileURLToPath(new URL('../src/authorization.ts', import.meta.url));
const subjectSource = () => readFileSync(sourcePath, 'utf8').replace(/(from\s+)(['"])(\.\/[^'"]+)\2/g,
  (_match, from, _quote, path) => from + JSON.stringify(new URL(path, new URL('../src/authorization.ts', import.meta.url)).href));
const source = subjectSource();
const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
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
const push = (command, session='owner') => ({session,cwd:'/repo',tool:'bash',input:{command}});
assert.equal(gate.approve('owner','interactive','approve-standing push-main C:/projetos/pi-optchat'),'standing');
assert.equal(gate.admit(push('git -C C:/projetos/pi-optchat push origin main')),undefined);
assert.equal(gate.admit(push('git -C C:/projetos/pi-optchat push origin main','other'))?.block,true,'standing grant must stay in its session');
assert.equal(gate.admit(push('git -C C:/projetos/pi-goal-x push origin main'))?.block,true,'standing grant must stay on listed roots');
assert.equal(gate.admit(push('git -C C:/projetos/pi-optchat push --force origin main'))?.block,true,'standing grant never covers force');
const launch = {session:'owner',cwd:'/repo',tool:'subagent',input:{agent:'worker',task:'x'}};
assert.equal(gate.admit(launch)?.block,true,'push grant must not cover paid subagents');
assert.equal(gate.approve('owner','interactive','approve-standing paid-subagents'),'standing');
assert.equal(gate.admit(launch),undefined);
assert.equal(gate.admit({...launch,tool:'codemode',input:{code:'await tools.subagent({})'}})?.block,true,'paid grant never covers nested codemode calls');
`;
const mutations = [
  ['provenance', "if (source !== 'interactive') return 'ignored';", ''],
  ['owner', "if (!entry || entry.session !== session || entry.approved) return 'invalid';", "if (!entry || entry.approved) return 'invalid';"],
  ['one-shot', 'this.pending.delete(token); return;', 'return;'],
  ['admission', '    if (diagnostic(call)) return;', '    return;'],
  ['standing-session', 'this.standing.get(call.session)?.has(key)', '[...this.standing.values()].some(set => set.has(key))'],
  ['standing-root', 'if (key && this.standing.get(call.session)?.has(key)) return;', 'if (key && this.standing.get(call.session)) return;'],
  ['standing-paid-scope', "if (call.tool === 'subagent') return 'paid-subagents';", "if (call.tool === 'subagent' || call.tool === 'codemode') return 'paid-subagents';"],
  ['standing-exact', "const pushMain = /^git -C (\\S+) push origin main$/;", "const pushMain = /^git -C (\\S+) push .*$/;"],
];
const outcomes = [];
function run(name, contents) {
  const dir = join(root, name); mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(dir, 'subject.ts'), contents);
  writeFileSync(join(dir, 'probe.mjs'), driver);
  const result = spawnSync(process.execPath, ['--import', loader, 'probe.mjs'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
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
assert.equal(subjectSource(), source, 'working source bytes preserved');
writeFileSync(join(root, 'result.json'), JSON.stringify({ baseline, mutations: outcomes, sourceUnchanged: true }, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, mutationsKilled: outcomes.length, sourceUnchanged: true, receipt: pathToFileURL(root).href }));
