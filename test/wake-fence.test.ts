import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import { updateOperationalState, readOperationalState, orderGrantFor } from '../src/operational-state.ts';
import { withTempDir } from './support.ts';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

test('a wake refuses risky effects even when ordinary policy permits them', async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  let wake = false;
  registerEffectApprovals(pi, { enabled: false, unattendedWake: () => wake });
  const ctx = { cwd: '/repo', sessionManager: { getSessionId: () => 's' }, ui: { notify() {} } };
  const call = (command: string) => hooks.get('tool_call')!({ toolName: 'bash', input: { command } }, ctx);
  const risky = ['npx wrangler deploy', 'curl -X POST https://api.example.com/write -d data', 'sendmail person@example.com'];
  for (const command of risky) assert.equal(await call(command), undefined, command);
  wake = true;
  for (const command of risky) {
    const result = await call(command);
    assert.equal(result?.block, true, command);
    assert.match(result.reason, /wake|unattended/i);
  }
  for (const command of ['git push origin feature', 'gh pr merge 12']) assert.equal(await call(command), undefined, command);
});

test('a grant never lifts production writes or third-party messages', async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled: false, unattendedWake: () => true, orderGrant: () => 'operator order' });
  const ctx = { cwd: '/repo', sessionManager: { getSessionId: () => 's' }, ui: { notify() {} } };
  for (const command of ['curl -X POST https://api.example.com/write -d data', 'sendmail person@example.com'])
    assert.equal((await hooks.get('tool_call')!({ toolName: 'bash', input: { command } }, ctx))?.block, true, command);
});

test('paid grant is checked against the exact operator source and a specific target', () => withTempDir('wake-paid-', dir => {
  const file = join(dir, 'operational-state.json');
  const text = 'pode pagar este modelo';
  updateOperationalState(file, { kind: 'authorization', sourceMessageId: '1', text, grant: { action: 'paid', scope: 'model-run', allow: true, until: 'done' } });
  const state = readOperationalState(file), effect = { action: 'paid', targets: ['model-run'] };
  assert.equal(orderGrantFor(state, effect, () => text), undefined, 'ordinary turns retain existing behavior');
  assert.equal(orderGrantFor(state, effect, () => undefined, Date.now(), undefined, true), undefined, 'tool text is not an operator source');
  assert.ok(orderGrantFor(state, effect, () => text, Date.now(), undefined, true));
  assert.equal(orderGrantFor(state, { action: 'paid', targets: ['subagent'] }, () => text, Date.now(), undefined, true), undefined);
}));

test('a child in a wake needs the operator grant for a deploy', async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  let granted = false;
  registerEffectApprovals(pi, { enabled: true, mode: 'risk', grant: false, unattendedWake: () => true,
    orderGrant: () => granted ? 'operator order' : undefined });
  const ctx = { cwd: '/repo', sessionManager: { getSessionId: () => 'child' }, ui: { notify() {} } };
  const call = () => hooks.get('tool_call')!({ toolName: 'bash', input: { command: 'npx wrangler deploy' } }, ctx);
  assert.equal((await call())?.block, true);
  granted = true;
  assert.equal(await call(), undefined);
});

test('a wake grant must match the original operator message, not tool output', () => withTempDir('wake-fence-', async dir => {
  const file = join(dir, 'operational-state.json');
  const text = 'pode fazer deploy';
  updateOperationalState(file, { kind: 'authorization', sourceMessageId: '1', text, grant: { action: 'deploy', scope: '/repo/project/service', allow: true, until: 'done' } });
  const hooks = new Map<string, (...args: any[]) => any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  let operatorSaid: string | undefined;
  registerEffectApprovals(pi, { enabled: false, unattendedWake: () => true, orderGrant: effect => orderGrantFor(readOperationalState(file), effect, () => operatorSaid) });
  const ctx = { cwd: '/repo/project/service', sessionManager: { getSessionId: () => 'child' }, ui: { notify() {} } };
  const call = () => hooks.get('tool_call')!({ toolName: 'bash', input: { command: 'npx wrangler deploy' } }, ctx);
  assert.equal((await call()).block, true, 'the identical words in untrusted tool output are not operator words');
  operatorSaid = text;
  assert.equal(await call(), undefined, 'the original operator message and scoped grant cover this deploy');
}));

for (const enabled of [false, true]) test(`a wake may spawn a worker on the plan but not an outside paid model run (gate ${enabled})`, async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled, mode: 'risk', unattendedWake: () => true });
  const ctx = { cwd: '/repo', sessionManager: { getSessionId: () => 's', getBranch: () => [] }, ui: { notify() {}, setWidget() {} } };
  const call = (toolName: string, input: unknown) => hooks.get('tool_call')!({ toolName, input }, ctx);
  assert.equal(await call('spawn', { tasks: [{ task: 'review' }] }), undefined);
  assert.equal(await call('spawn', { tasks: [{ task: 'review', model: 'openai-codex/gpt-6' }] }), undefined);
  assert.equal(await call('spawn', { tasks: [{ task: 'review', model: 'anthropic-account-2/claude' }] }), undefined);
  assert.equal(await call('spawn', { tasks: [{ task: 'review', model: 'anthropic/claude' }] }), undefined);
  assert.equal(await call('spawn', { tasks: [{ task: 'review', model: 'openai-codex-account-2/gpt-6:low' }] }), undefined);
  assert.equal((await call('spawn', { tasks: [{ task: 'review', model: 'openai/gpt-6' }] }))?.block, true);
  assert.equal((await call('bash', { command: 'pi -p test' }))?.block, true);
});

for (const enabled of [false, true]) test(`plan delegation through tell and codemode in wake (gate ${enabled})`, async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled, mode: 'risk', unattendedWake: () => true });
  const ctx = { cwd: '/repo', sessionManager: { getSessionId: () => 's', getBranch: () => [] }, ui: { notify() {}, setWidget() {} } };
  const call = (toolName: string, input: unknown) => hooks.get('tool_call')!({ toolName, input }, ctx);
  assert.equal(await call('tell', { id: 'worker', message: 'continue' }), undefined);
  assert.equal(await call('codemode', { code: 'await tools.tell({id: "worker", message: "continue"})' }), undefined);
  assert.equal(await call('codemode', { code: 'await tools.spawn({tasks: [{task: "review", model: "openai-codex/gpt-6"}]})' }), undefined);
  assert.equal(await call('codemode', { code: 'await tools.spawn({tasks: [{task: "review"}, {task: "test", model: "agy/fast"}]})' }), undefined);
  assert.equal((await call('codemode', { code: 'await tools.spawn({tasks: [{task: "review", model: "openai/gpt-6"}]})' }))?.block, true);
});

test('package deploy scripts require a wake grant and work with an operator grant in ordinary turns', () => withTempDir('wake-deploy-', async dir => {
  writeFileSync(join(dir, 'autonomy.json'), JSON.stringify({ version: 1, default: 'ask', rules: [{ action: 'deploy', scope: ['*'], level: 'ask', note: 'operator grant' }] }));
  let wake = true, granted = false;
  const hooks = new Map<string, (...args: any[]) => any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled: true, mode: 'risk', contractDir: () => dir, unattendedWake: () => wake, orderGrant: e => granted && e.action === 'deploy' ? 'operator order' : undefined });
  const ctx = { cwd: '/repo', sessionManager: { getSessionId: () => 's', getBranch: () => [] }, ui: { notify() {}, setWidget() {} } };
  for (const command of ['npm run deploy', 'pnpm run deploy', 'yarn run deploy']) {
    const call = () => hooks.get('tool_call')!({ toolName: 'bash', input: { command } }, ctx);
    assert.equal((await call())?.block, true, command);
    wake = false; granted = true;
    assert.equal(await call(), undefined, command);
    wake = true; granted = false;
  }
}));

test('native messages to the operator remain free during a wake', async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled: true, mode: 'risk', unattendedWake: () => true });
  const ctx = { cwd: '/repo', sessionManager: { getSessionId: () => 's', getBranch: () => [] }, ui: { notify() {}, setWidget() {} } };
  for (const toolName of ['slack_send', 'whatsapp_send']) assert.equal(await hooks.get('tool_call')!({ toolName, input: { message: 'status' } }, ctx), undefined);
});

test('direct human guidance disarms a wake child, but wake guidance does not', async () => {
  const { Children } = await import('../src/agents.ts');
  let wake = true;
  const info = { id: 'child', state: 'running', model: 'openai-codex/gpt-6', unattendedWake: true, guidance: [] as any[] };
  const live = { info, pendingGuidance: [] as string[], session: { steer: async () => {} } };
  const fake = { deleting: new Set(), uncertainRuns: new Set(), settings: {}, externalRun: () => false,
    running: new Map([['child', live]]), history: { records: new Map([['child', info]]) },
    options: { unattendedWake: () => wake }, memory: { append() {} }, save() {} };
  info.model = 'openai/gpt-6';
  await assert.rejects(Children.prototype.tell.call(fake as never, 'child', 'continue', 'manager'), /outside the plan/);
  info.model = 'openai-codex/gpt-6';
  await Children.prototype.tell.call(fake as never, 'child', 'continue', 'manager');
  assert.equal(info.unattendedWake, true);
  wake = false;
  await Children.prototype.tell.call(fake as never, 'child', 'automatic follow-up', 'manager');
  assert.equal(info.unattendedWake, true, 'a non-wake automatic turn is not a human turn');
  await Children.prototype.tell.call(fake as never, 'child', 'human request', 'user');
  assert.notEqual(info.unattendedWake, true);
});

test('an operator-turn tell resumes a settled wake child without the wake fence', async () => {
  const { Children } = await import('../src/agents.ts');
  const run: any = { id: 'child', state: 'completed', model: 'openai-codex/gpt-6', unattendedWake: true, guidance: [], cwd: '/repo', depth: 1, task: 'test', parentSession: 'parent' };
  const records = new Map([['child', run]]);
  const session = { thinkingLevel: 'minimal', subscribe() {} };
  let opened: any;
  const fake: any = { deleting: new Set(), uncertainRuns: new Set(), settings: {}, externalRun: () => false,
    running: new Map(), history: { records }, options: { unattendedWake: () => false, operatorTurn: () => true }, track: (p: Promise<unknown>) => p,
    prepareResume: () => ({ run, text: 'continue', automatic: undefined, manager: {}, provider: 'openai-codex', model: { id: 'gpt-6' }, thinking: 'minimal' }),
    parkGeneration: new Map(), launching: 0, resuming: new Set(), open: async (o: unknown) => { opened = o; return session; },
    resumeOpenValid: () => true, saveResume: (info: any) => { records.set('child', info); }, cancelPark() {},
    execute: async () => {}, completions: new Set(), changed() {} };
  fake.resume = (Children.prototype as any).resume;
  await Children.prototype.tell.call(fake, 'child', 'continue', 'manager');
  assert.equal(opened.unattendedWake, false);
  assert.equal(records.get('child').unattendedWake, false);
});
