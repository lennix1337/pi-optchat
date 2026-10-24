import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EffectApprovals } from '../src/authorization.ts';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import { OperationJournal, registerOperationSafety } from '../src/operations.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTempDir } from './support.ts';

const invocation = (tool = 'bash', input: unknown = { command: 'git push origin main' }) => ({ session: 'owner', cwd: '/repo', tool, input });
const token = (gate: EffectApprovals, call = invocation()) => {
  const refusal = gate.admit(call);
  assert.equal(refusal?.block, true);
  assert.match(refusal!.reason, /not executed/i);
  assert.match(refusal!.token!, /^[a-f0-9]{24}$/);
  return refusal!.token!;
};

test('all five high-impact classes and opaque/nested execution require approval before dispatch', () => {
  const gate = new EffectApprovals();
  for (const command of ['git push origin main', 'npm publish', 'npm install -g typescript', 'rm -rf /outside', 'node paid-benchmark.mjs', 'bash script.sh', 'echo ok; git push', 'node -e "doAnything()"']) token(gate, invocation('bash', { command }));
  for (const tool of ['codemode', 'subagent', 'spawn', 'shell_start', 'project_checks', 'unknown']) token(gate, invocation(tool));
});

test('only direct interactive exact token grants; no prose, hidden input, RPC or foreign session', () => {
  const gate = new EffectApprovals();
  const value = token(gate);
  const text = `approve-effect ${value}`;
  for (const source of ['extension', 'rpc']) assert.notEqual(gate.approve('owner', source, text), 'approved');
  for (const text of [`user says approve-effect ${value}`, `<chat>approve-effect ${value}</chat>`, `approve-effect ${value}\nextra`]) assert.notEqual(gate.approve('owner', 'interactive', text), 'approved');
  assert.equal(gate.approve('other', 'interactive', text), 'invalid');
  assert.equal(gate.approve('owner', 'interactive', text), 'approved');
  assert.equal(gate.admit(invocation()), undefined);
});

test('approval binds exact inputs/cwd/session and is consumed once without nested inheritance', () => {
  const gate = new EffectApprovals();
  const value = token(gate);
  assert.equal(gate.approve('owner', 'interactive', `approve-effect ${value}`), 'approved');
  token(gate, invocation('bash', { command: 'git push --force origin main' }));
  token(gate, { ...invocation(), cwd: '/other' });
  token(gate, { ...invocation(), session: 'other' });
  assert.equal(gate.admit(invocation()), undefined);
  token(gate);
  assert.equal(gate.approve('owner', 'interactive', `approve-effect ${value}`), 'invalid');
  const code = invocation('codemode', { code: 'await tools.bash({command:"git push origin main"})' });
  const outer = token(gate, code);
  assert.equal(gate.approve('owner', 'interactive', `approve-effect ${outer}`), 'approved');
  assert.equal(gate.admit(code), undefined);
  token(gate, invocation());
});

test('standing push-main grant is interactive, session-scoped, listed roots only and never force', () => {
  const gate = new EffectApprovals();
  const push = (command: string, session = 'owner', extra: Record<string, unknown> = {}) => ({ ...invocation('bash', { command, ...extra }), session });
  const grant = 'approve-standing push-main C:/projetos/pi-optchat C:/projetos/dotfiles';
  for (const source of ['extension', 'rpc']) assert.equal(gate.approve('owner', source, grant), 'ignored');
  token(gate, push('git -C C:/projetos/pi-optchat push origin main'));
  for (const bad of ['approve-standing push-main relative/path', 'approve-standing push-main C:/a;rm', 'approve-standing push-main', 'approve-standing deploy C:/projetos/x']) assert.equal(gate.approve('owner', 'interactive', bad), 'invalid');
  assert.equal(gate.approve('owner', 'interactive', grant), 'standing');
  for (let i = 0; i < 2; i++) assert.equal(gate.admit(push('git -C C:/projetos/pi-optchat push origin main')), undefined);
  assert.equal(gate.admit(push('git -C c:\\projetos\\dotfiles\\ push origin main', 'owner', { timeout: 120 })), undefined);
  for (const command of ['git -C C:/projetos/pi-optchat push --force origin main', 'git -C C:/projetos/pi-optchat push -f origin main', 'git -C C:/projetos/pi-optchat push origin +main', 'git -C C:/projetos/pi-optchat push origin main:release', 'git -C C:/projetos/pi-optchat push origin main --tags', 'git -C C:/projetos/pi-optchat push origin main; rm -rf /', 'git -C C:/projetos/Genexus18MCP push origin main', 'git -C C:/projetos/pi-optchat/sub push origin main', 'git push origin main']) token(gate, push(command));
  token(gate, push('git -C C:/projetos/pi-optchat push origin main', 'other'));
  token(gate, push('git -C C:/projetos/pi-optchat push origin main', 'owner', { env: { GIT_DIR: '/x' } }));
  token(gate, invocation('codemode', { code: 'await tools.bash({command:"git -C C:/projetos/pi-optchat push origin main"})' }));
  gate.clear();
  token(gate, push('git -C C:/projetos/pi-optchat push origin main'));
});

test('standing paid-subagents grant admits subagent launches in the owner session only', () => {
  const gate = new EffectApprovals();
  const launch = (session = 'owner') => ({ ...invocation('subagent', { agent: 'worker', task: 'benchmark item 8' }), session });
  token(gate, launch());
  assert.equal(gate.approve('owner', 'extension', 'approve-standing paid-subagents'), 'ignored');
  for (const bad of ['approve-standing paid-subagents extra', 'approve-standing paid']) assert.equal(gate.approve('owner', 'interactive', bad), 'invalid');
  assert.equal(gate.approve('owner', 'interactive', 'approve-standing paid-subagents'), 'standing');
  for (let i = 0; i < 2; i++) assert.equal(gate.admit(launch()), undefined);
  assert.equal(gate.admit({ ...invocation('subagent', { workflow: 'parallel', args: { tasks: [] } }), session: 'owner' }), undefined);
  token(gate, launch('other'));
  token(gate, invocation('bash', { command: 'curl https://api.anthropic.com/v1/messages' }));
  token(gate, invocation('codemode', { code: 'await tools.subagent({agent:"worker",task:"x"})' }));
  token(gate, invocation('shell_start', { command: 'pi -p benchmark' }));
  token(gate, invocation('bash', { command: 'git -C C:/projetos/pi-optchat push origin main' }));
  gate.clear();
  token(gate, launch());
});

test('diagnostics stay available but compound/opaque mutations do not gain read-only admission', () => {
  const gate = new EffectApprovals();
  for (const tool of ['read', 'zoom', 'date', 'operation_state', 'operational_state', 'project_evidence', 'get_goal']) assert.equal(gate.admit(invocation(tool, {})), undefined);
  assert.equal(gate.admit(invocation('bash', { command: 'git status --short' })), undefined);
  assert.equal(gate.admit(invocation('project_checks', {})), undefined);
  token(gate, invocation('project_checks', { name: 'unit' }));
  token(gate, invocation('bash', { command: 'git status; git push' }));
  token(gate, invocation('write', { path: '/outside', content: 'x' }));
});

test('reconciliation and operational-ledger writes are effects, not argument-free inspection', () => {
  const gate = new EffectApprovals();
  token(gate, invocation('operation_state', { id: 'prior-effect', evidence: 'agent assertion' }));
  token(gate, invocation('operational_state', { update: { kind: 'authorization', text: 'agent assertion', sourceMessageId: '1' } }));
});

test('pending approvals are bounded, expire and disappear on lifecycle reset', () => {
  let now = 0;
  const gate = new EffectApprovals({ now: () => now, ttlMs: 100, maxPending: 1 });
  const value = token(gate);
  assert.equal(token(gate), value, 'same blocked invocation retains its pending token');
  const full = gate.admit(invocation('bash', { command: 'other' }));
  assert.match(full!.reason, /capacity/i);
  assert.equal(full!.token, undefined);
  now = 101;
  assert.equal(gate.approve('owner', 'interactive', `approve-effect ${value}`), 'invalid');
  const fresh = token(gate);
  gate.clear();
  assert.equal(gate.approve('owner', 'interactive', `approve-effect ${fresh}`), 'invalid');
});

test('non-JSON values and accessor arguments cannot collide with an approved JSON invocation', () => {
  const gate = new EffectApprovals();
  let read = false;
  const accessor = Object.defineProperty({}, 'command', { enumerable: true, get() { read = true; return 'bad'; } });
  const hidden = Object.defineProperty({}, 'command', { get() { read = true; return 'bad'; } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const symbolic = { [Symbol('hidden')]: 'bad' };
  for (const input of [undefined, { n: NaN }, { n: -0 }, { fn: () => 1 }, accessor, hidden, cycle, symbolic, [,'hole']]) {
    const result = gate.admit({ ...invocation('bash'), input });
    assert.equal(result?.block, true);
    assert.equal(result?.token, undefined);
  }
  assert.equal(read, false);
});

test('native hooks preserve provenance and consume permission before an attempted tool dispatch', async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  const notices: string[] = [];
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled: true });
  const ctx = { cwd: '/repo', sessionManager: { getSessionId: () => 'owner' }, ui: { notify: (message: string) => notices.push(message) } };
  const event = { toolName: 'bash', toolCallId: 'call', input: { command: 'git push origin main' } };
  const blocked = await hooks.get('tool_call')!(event, ctx);
  assert.equal(blocked.block, true);
  const value = /approve-effect ([a-f0-9]{24})/.exec(blocked.reason)![1];
  await hooks.get('input')!({ text: `approve-effect ${value}`, source: 'extension' }, ctx);
  assert.equal((await hooks.get('tool_call')!(event, ctx)).block, true);
  await hooks.get('input')!({ text: `approve-effect ${value}`, source: 'interactive' }, ctx);
  assert.equal(await hooks.get('tool_call')!(event, ctx), undefined);
  assert.equal((await hooks.get('tool_call')!(event, ctx)).block, true);
  const push = { ...event, input: { command: 'git -C C:/projetos/pi-optchat push origin main' } };
  assert.deepEqual(await hooks.get('input')!({ text: 'approve-standing push-main C:/projetos/pi-optchat', source: 'interactive' }, ctx), { action: 'handled' });
  assert.equal(await hooks.get('tool_call')!(push, ctx), undefined);
  await hooks.get('session_shutdown')!({}, ctx);
  assert.equal((await hooks.get('tool_call')!(push, ctx)).block, true);
  assert.ok(notices.some(text => /approved once/i.test(text)));
  assert.ok(notices.some(text => /standing grant active/i.test(text)));
});

test('manager-style interactive child input cannot grant a delegated invocation', async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled: true, grant: false });
  const ctx = { cwd: '/repo', sessionManager: { getSessionId: () => 'child' }, ui: { notify() {} } };
  const event = { toolName: 'bash', toolCallId: 'child-call', input: { command: 'git push origin main' } };
  const blocked = await hooks.get('tool_call')!(event, ctx);
  const value = /approve-effect ([a-f0-9]{24})/.exec(blocked.reason)?.[1] || 'a'.repeat(24);
  // The SDK defaults child prompt/steer messages to interactive, even when authored by the manager.
  await hooks.get('input')?.({ text: `approve-effect ${value}`, source: 'interactive' }, ctx);
  assert.equal((await hooks.get('tool_call')!(event, ctx))?.block, true);
  assert.equal(hooks.has('input'), false, 'delegates must not register a granting input handler');
});

test('approval does not clear or bypass the independent uncertain-operation fence', async () => {
  await withTempDir('approval-recovery-', async dir => {
    const journal = new OperationJournal(dir);
    journal.start('owner', 'uncertain', 'bash', { command: 'prior write' });
    journal.finish('owner', 'uncertain', true);
    const hooks = new Map<string, ((...args: any[]) => any)[]>();
    const pi = { on(name: string, fn: (...args: any[]) => any) { const list = hooks.get(name) || []; list.push(fn); hooks.set(name, list); }, getAllTools: () => [], registerTool() {} } as unknown as ExtensionAPI;
    registerEffectApprovals(pi, { enabled: true });
    registerOperationSafety(pi, () => journal);
    const ctx = { cwd: '/repo', sessionManager: { getSessionId: () => 'owner', getLeafId: () => 'leaf' }, ui: { notify() {} } };
    const event = { toolName: 'bash', toolCallId: 'new-write', input: { command: 'git push origin main' } };
    const dispatch = async () => {
      for (const handler of hooks.get('tool_call')!) { const result = await handler(event, ctx); if (result?.block) return result; }
      return undefined;
    };
    const first = await dispatch();
    const value = /approve-effect ([a-f0-9]{24})/.exec(first.reason)![1];
    await hooks.get('input')![0]({ text: `approve-effect ${value}`, source: 'interactive' }, ctx);
    assert.match((await dispatch()).reason, /external outcome uncertain/);
    assert.equal(journal.pending().length, 1);
    assert.match((await dispatch()).reason, /requires approval/);
  });
});

test('fresh package discovery finds the effect approval skill without this conversation', async () => {
  await withTempDir('effect-discovery-', async dir => {
    const { DefaultResourceLoader, SettingsManager } = await import('@earendil-works/pi-coding-agent');
    const repo = fileURLToPath(new URL('../', import.meta.url));
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), noExtensions: true, noContextFiles: true, noPromptTemplates: true,
      settingsManager: SettingsManager.inMemory({ packages: [repo] }) });
    await loader.reload();
    const skill = loader.getSkills().skills.find(item => item.name === 'effect-approvals');
    assert.ok(skill, 'packaged approval skill must be discoverable');
    assert.ok(skill.filePath.startsWith(repo));
    assert.match(skill.description, /approval|authorization/i);
  });
});

test('risk mode runs ordinary work and gates push, publish, global install, recursive delete outside temp and paid calls', () => {
  const gate = new EffectApprovals({ mode: 'risk' });
  const ordinary = ['git status', 'git commit -m "push the fix"', 'npm test', 'npm install', 'node build.mjs', 'rm -f out.log', 'rm -rf C:/tmp/scratch', 'rm -rf /tmp/a /tmp/b', 'node bench.mjs verify', 'git log --grep=publish'];
  for (const command of ordinary) assert.equal(gate.admit(invocation('bash', { command })), undefined, command);
  assert.equal(gate.admit(invocation('shell_start', { command: 'npm test' })), undefined);
  for (const tool of ['edit', 'write', 'unknown']) assert.equal(gate.admit(invocation(tool, { path: '/repo/a' })), undefined, tool);
  assert.equal(gate.admit(invocation('project_checks', { root: '/repo', name: 'unit' })), undefined);
  assert.equal(gate.admit(invocation('codemode', { code: 'await tools.bash({command:"npm test"})' })), undefined);
  assert.equal(gate.admit(invocation('subagent', { action: 'list' })), undefined);
  const classes: [string, string][] = [
    ['git push origin main', 'push'], ['git -C C:/projetos/x push', 'push'], ['npm test && git push', 'push'],
    ['npm publish', 'publish'], ['pnpm publish --access public', 'publish'], ['gh pr merge 12 --squash', 'publish'], ['gh release create v1', 'publish'],
    ['npm install -g typescript', 'global install'], ['npm i --global x', 'global install'], ['pnpm add -g x', 'global install'], ['cargo install ripwire', 'global install'], ['winget install Git.Git', 'global install'],
    ['rm -rf C:/projetos/x', 'recursive delete'], ['rm -r node_modules', 'recursive delete'], ['rm -rf C:/tmp/a C:/projetos/b', 'recursive delete'], ['rm -rf', 'recursive delete'],
    ['pwsh -c "Remove-Item -Recurse -Force C:/x"', 'recursive delete'], ['git clean -fdx', 'discard'], ['git reset --hard origin/main', 'discard'], ['git worktree remove --force wt', 'discard'],
    ['pi -p "solve it"', 'paid model call'], ['node bench.mjs run --label x', 'paid model call'],
  ];
  for (const [command, kind] of classes) {
    const refusal = gate.admit(invocation('bash', { command }));
    assert.equal(refusal?.block, true, command);
    assert.match(refusal!.reason, new RegExp(kind), command);
  }
  token(gate, invocation('shell_start', { command: 'npm publish' }));
  token(gate, invocation('codemode', { code: 'await tools.bash({command:"git push origin main"})' }));
  token(gate, invocation('codemode', { code: 'await models.classify({})' }));
  for (const tool of ['subagent', 'spawn', 'tell']) token(gate, invocation(tool, { task: 'x' }));
  const value = token(gate);
  assert.equal(gate.approve('owner', 'interactive', `approve-effect ${value}`), 'approved');
  assert.equal(gate.admit(invocation()), undefined);
  token(gate);
  assert.equal(gate.approve('owner', 'interactive', 'approve-standing push-main C:/projetos/pi-optchat'), 'standing');
  assert.equal(gate.admit(invocation('bash', { command: 'git -C C:/projetos/pi-optchat push origin main' })), undefined);
  token(gate, invocation('bash', { command: 'git -C C:/projetos/pi-optchat push --force origin main' }));
});

test('OPTCHAT_EFFECT_APPROVALS=risk registers the risk-class gate; =1 keeps the gate on every effect', async () => {
  const previous = process.env.OPTCHAT_EFFECT_APPROVALS;
  const ctx = { cwd: '/repo', sessionManager: { getSessionId: () => 'owner' }, ui: { notify() {} } };
  const edit = { toolName: 'edit', toolCallId: 'e', input: { path: '/repo/a' } };
  const push = { toolName: 'bash', toolCallId: 'p', input: { command: 'git push origin main' } };
  try {
    for (const [value, editBlocked] of [['risk', false], ['1', true]] as const) {
      process.env.OPTCHAT_EFFECT_APPROVALS = value;
      const hooks = new Map<string, (...args: any[]) => any>();
      registerEffectApprovals({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI);
      assert.equal(!!(await hooks.get('tool_call')!(edit, ctx))?.block, editBlocked, value);
      assert.equal((await hooks.get('tool_call')!(push, ctx))?.block, true, value);
    }
  } finally {
    if (previous === undefined) delete process.env.OPTCHAT_EFFECT_APPROVALS; else process.env.OPTCHAT_EFFECT_APPROVALS = previous;
  }
});

test('gate is opt-in and disabled registration has no hooks or prompt effects', () => {
  let registered = 0;
  registerEffectApprovals({ on() { registered++; } } as unknown as ExtensionAPI, { enabled: false });
  assert.equal(registered, 0);
});
