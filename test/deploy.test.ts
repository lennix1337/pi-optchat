import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDelegationNudge } from '../src/crew.ts';
import { DEPLOY_COMMANDS, DeployWatch, HOLD, RELEASE, clock, isDeployCommand, refusal, registerDeployGuard, workerHooks } from '../src/deploy.ts';
import { loadConfig } from '../src/profiles.ts';
import { ShellJobs, runningShells } from '../src/shells.ts';
import { atWork } from '../src/transcript.ts';

type Handler = (event: any) => any;
/** A Pi whose events run every handler registered for them, in registration order, like Pi does. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = { on: (name: string, handler: Handler) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); } };
  const emit = (name: string, event: any = {}) => { let last: any; for (const handler of handlers.get(name) ?? []) last = handler(event) ?? last; return last; };
  return { pi, emit };
}

/** The extension's wiring: the guard, the nudge and the watch over one ShellJobs. */
function harness(options: { extra?: string[]; working?: { id: string }[]; delegateAfter?: number } = {}) {
  const { pi, emit } = fakePi();
  const shells = new ShellJobs();
  const told: string[] = [];
  const workers = { working: options.working ?? [], tell: async (id: string, message: string) => { told.push(`${id}: ${message}`); } };
  const watch = new DeployWatch({ shells: () => runningShells(shells), extra: () => options.extra ?? [] }, workerHooks(() => workers));
  registerDeployGuard(pi as never, watch, listener => shells.subscribe(listener));
  registerDelegationNudge(pi as never, () => options.delegateAfter ?? 2, () => true, () => watch.quiet());
  emit('session_start');
  let id = 0;
  const call = (toolName: string, input: Record<string, unknown> = {}) => {
    const toolCallId = `c${++id}`;
    const blocked = emit('tool_call', { toolName, toolCallId, input });
    return { toolCallId, blocked, finish: (text = 'ok') => emit('tool_result', { toolName, toolCallId, input, content: [{ type: 'text', text }] }) };
  };
  /** A tool result as the nudge hook sees it: whether the delegation reminder joined it. */
  const nudged = (toolName: string, command: string) => {
    const { toolCallId, blocked } = call(toolName, { command });
    assert.equal(blocked, undefined);
    const patched = emit('tool_result', { toolName, toolCallId, input: { command }, content: [{ type: 'text', text: 'ok' }] });
    return Boolean(patched?.content?.some((block: { text: string }) => block.text.includes('[crew]')));
  };
  return { emit, shells, watch, told, call, nudged };
}

/** A shell body that ends when the test says so, successfully or not. */
function gate() {
  let end!: (ok: boolean) => void;
  const done = new Promise<{ output: string; failed: boolean }>((resolve, reject) => { end = ok => ok ? resolve({ output: 'live', failed: false }) : reject(new Error('gates failed')); });
  done.catch(() => {});
  return { run: () => done, end: (ok = true) => end(ok) };
}

const DEPLOYS = [
  'pwsh -File scripts/release/deploy-web.ps1 -Commit abc123',
  'cd C:/projetos/dentai-mono/worktrees/_deploy-main && pwsh -NoProfile -File scripts/release/deploy-web.ps1 -Commit abc 2>&1 | tee C:/tmp/deploy.log; echo rc=${PIPESTATUS[0]}',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/api/deploy-prod.ps1 -Commit 61730209',
  './scripts/deploy-all.ps1',
  "& 'C:\\repo\\scripts\\deploy-changed.ps1' -Commit abc",
  'pwsh -Command "& ./scripts/release/run-rollout-web.ps1 -Commit abc"',
  'D=worktrees/release-state/abc && powershell.exe -NoProfile -ExecutionPolicy Bypass -File $D/run-gates.ps1; if [ $? -eq 0 ]; then powershell.exe -NoProfile -File $D/run-rollout.ps1; fi',
  'bash scripts/deploy-web.ps1',
];
const NOT_DEPLOYS = [
  'cat scripts/release/deploy-web.ps1',
  'grep -n "Write-Host" scripts/deploy-all.ps1 | head -40',
  'git add apps/api/deploy-prod.ps1 && git commit -m "fix deploy-prod.ps1"',
  'ls scripts/release/run-rollout*.ps1',
  'pwsh -NoProfile -File scripts/release/run-gates.ps1',
  'npm run build',
  'echo deploy-web.ps1',
  'pwsh -File scripts/release/deploy-web.ps1.bak',
  'pwsh -File scripts/release/my-deploy-web.ps1',
  'pwsh -File scripts/release/deploy-web.ps1 -PlanOnly',
  'pwsh -File scripts/release/deploy-web.ps1 -WhatIf',
  '',
];

test('the detector finds the run of a deploy entry point and nothing that only mentions one', () => {
  for (const command of DEPLOYS) assert.equal(isDeployCommand(command), true, `deploy: ${command}`);
  for (const command of NOT_DEPLOYS) assert.equal(isDeployCommand(command), false, `not a deploy: ${command}`);
  assert.deepEqual([...DEPLOY_COMMANDS], ['deploy-web.ps1', 'deploy-prod.ps1', 'deploy-all.ps1', 'deploy-changed.ps1', 'run-rollout*.ps1']);
});

test('the profile adds its own deploy entry points, by script name or command prefix', () => {
  assert.equal(isDeployCommand('node scripts/ship-it.mjs --prod'), false);
  assert.equal(isDeployCommand('node scripts/ship-it.mjs --prod', ['ship-it.mjs']), true);
  assert.equal(isDeployCommand('cd app && fly deploy --remote-only', ['fly deploy']), true, 'a prefix with a space matches the command line');
  assert.equal(isDeployCommand('fly status', ['fly deploy']), false);
  assert.equal(isDeployCommand('pwsh -File scripts/push-*.ps1', ['push-*.ps1']), true, 'a star matches any characters');
  assert.equal(isDeployCommand('pwsh -File deploy-web.ps1', ['  ']), true, 'a blank entry is ignored, the defaults stay');
});

test('a profile config keeps deployCommands and refuses anything that is not a list of text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-deploy-'));
  const model = { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'high' };
  const load = (extra: object) => { writeFileSync(join(dir, 'config.json'), JSON.stringify({ compactor: model, subagent: model, ...extra })); return loadConfig(dir); };
  try {
    assert.deepEqual(load({ deployCommands: ['fly deploy', 'ship-it.mjs'] }).deployCommands, ['fly deploy', 'ship-it.mjs']);
    assert.equal(load({}).deployCommands, undefined);
    assert.throws(() => load({ deployCommands: 'fly deploy' }), /Invalid profile config/);
    assert.throws(() => load({ deployCommands: [1] }), /Invalid profile config/);
    assert.throws(() => load({ deployCommands: [' '] }), /Invalid profile config/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the delegation reminder is silent in a turn that ran a deploy and while one runs, and comes back after', () => {
  const h = harness();
  h.emit('agent_start');
  assert.equal(h.nudged('bash', 'git status --short && npm test'), false, 'first execution call');
  assert.equal(h.nudged('bash', 'npm run build'), true, 'the reminder fires as before in an ordinary turn');
  // A turn that ran a deploy command: the reminder stays quiet for the rest of that turn, even after the deploy returned.
  h.emit('agent_start');
  assert.equal(h.nudged('bash', 'pwsh -File scripts/release/deploy-web.ps1 -Commit abc'), false);
  for (let i = 0; i < 6; i++) assert.equal(h.nudged('bash', `npm run step-${i}`), false, `quiet after the deploy command, call ${i}`);
  h.emit('agent_start');
  assert.equal(h.nudged('bash', 'npm run a'), false);
  assert.equal(h.nudged('bash', 'npm run b'), true, 'the next turn is an ordinary one');

  // A deploy shell started in an earlier turn keeps every later turn quiet until it ends.
  const running = gate();
  const shell = h.shells.start('pwsh -File scripts/release/deploy-web.ps1 -Commit abc', '/project', running.run);
  h.emit('agent_start');
  for (let i = 0; i < 6; i++) assert.equal(h.nudged('edit', `x${i}`), false, `quiet while the deploy shell runs, call ${i}`);
  running.end();
  return h.shells.settle(shell, 5_000).then(() => {
    h.emit('agent_start');
    assert.equal(h.nudged('bash', 'npm run a'), false);
    assert.equal(h.nudged('bash', 'npm run b'), true, 'the reminder is back once the shell has ended');
  });
});

test('spawn and subagent launches are refused while a deploy shell runs, and allowed again when it ends well or badly', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    const h = harness();
    assert.equal(h.call('spawn', { tasks: [] }).blocked, undefined, 'no deploy, no refusal');
    const running = gate();
    const shell = h.shells.start('pwsh -NoProfile -File scripts/release/deploy-web.ps1 -Commit abc', '/project', running.run);
    const spawn = h.call('spawn', { tasks: [{ task: 'Goal: x' }] }).blocked;
    assert.equal(spawn?.block, true, outcome);
    assert.match(spawn.reason, /^Deploy em andamento desde \d\d:\d\d: segure novos agentes até a troca ser verificada\./);
    assert.match(spawn.reason, new RegExp(`shell_stop ${h.shells.find(shell)!.id.slice(0, 8)}`), 'a stuck shell can be stopped');
    assert.equal(h.call('subagent', { agent: 'worker', task: 'x' }).blocked?.block, true, 'the pi-subagents launch is refused too');
    assert.equal(h.call('subagent', { action: 'list' }).blocked, undefined, 'managing runs that exist is not a launch');
    assert.equal(h.call('tell', { id: 'a1', message: 'x' }).blocked, undefined, 'telling a running worker stays allowed');
    running.end(outcome === 'success');
    await h.shells.settle(shell, 5_000);
    assert.equal(h.shells.find(shell)?.state, outcome === 'success' ? 'completed' : 'failed');
    assert.equal(h.call('spawn', { tasks: [] }).blocked, undefined, `released after a ${outcome}`);
    assert.equal(h.call('subagent', { agent: 'worker', task: 'x' }).blocked, undefined);
    assert.equal(h.watch.active(), undefined);
  }
});

test('a foreground deploy call refuses launches until its result arrives, whatever the result', () => {
  for (const tool of ['bash', 'powershell']) {
    const h = harness();
    const deploy = h.call(tool, { command: 'pwsh -File scripts/release/deploy-web.ps1 -Commit abc' });
    assert.equal(h.call('spawn', { tasks: [] }).blocked?.block, true);
    deploy.finish('Command exited with code 1');
    assert.equal(h.call('spawn', { tasks: [] }).blocked, undefined);
    // A call that other hooks refuse still ends with a tool result: the watch cannot stay stuck.
    const refused = h.call(tool, { command: 'pwsh -File scripts/release/deploy-web.ps1 -Commit abc' });
    refused.finish('Blocked');
    assert.equal(h.watch.active(), undefined);
  }
});

test('a deploy that a long bash call became a shell stays in flight through the shell', async () => {
  const h = harness();
  const command = 'pwsh -File scripts/release/deploy-web.ps1 -Commit abc';
  const bash = h.call('bash', { command });
  const running = gate();
  const shell = h.shells.start(command, '/project', running.run);
  bash.finish('moved to shell');
  assert.equal(h.call('spawn', { tasks: [] }).blocked?.block, true, 'the shell keeps the deploy in flight after the call returned');
  assert.equal(h.watch.active()?.shell, shell);
  running.end();
  await h.shells.settle(shell, 5_000);
  assert.equal(h.call('spawn', { tasks: [] }).blocked, undefined);
});

test('running workers hear one hold message when a deploy starts and one release when it ends', async () => {
  const h = harness({ working: [{ id: 'w1' }, { id: 'w2' }] });
  const running = gate();
  const shell = h.shells.start('pwsh -File scripts/release/deploy-web.ps1', '/project', running.run);
  h.shells.update(shell, 'gates…'); // Output updates are not new deploys.
  h.call('spawn', { tasks: [] });
  assert.deepEqual(h.told.map(line => line.split(':')[0]), ['w1', 'w2']);
  assert.ok(h.told[0].includes(HOLD(h.watch.active()!).slice(0, 60)));
  assert.match(h.told[0], /Hold heavy local work \(test suites, builds, commit hooks/);
  running.end(false);
  await h.shells.settle(shell, 5_000);
  assert.deepEqual(h.told.slice(2).map(line => line.split(': ').slice(1).join(': ')), [RELEASE, RELEASE]);
  assert.equal(h.told.length, 4);
});

test('the status note shows the deploy, with or without agents and shells', () => {
  const since = Date.UTC(2026, 10, 9, 21, 15);
  assert.equal(clock(since), '18:15', 'Brasília time');
  const note = atWork([], [], { since, command: 'pwsh -File scripts/release/deploy-web.ps1 -Commit abc' })!;
  assert.match(note, /^\[OptChat status\] Production deploy in flight since 18:15: "pwsh -File scripts\/release\/deploy-web\.ps1 -Commit abc"\./);
  assert.match(note, /never through a worker/);
  assert.equal(atWork([], []), undefined);
  assert.match(atWork([{ id: 'a1', task: 'Fix it' }], [], { since, command: 'x' })!, /Agents at work now: a1 "Fix it"\. Production deploy in flight since 18:15/);
  assert.match(refusal({ since, command: 'x' }), /^Deploy em andamento desde 18:15: segure novos agentes até a troca ser verificada/);
});

test('shutdown lets go of the shells and the deploy state', async () => {
  const h = harness({ working: [{ id: 'w1' }] });
  const bash = h.call('bash', { command: 'pwsh -File scripts/release/deploy-web.ps1' });
  assert.ok(h.watch.active());
  h.emit('session_shutdown');
  assert.equal(h.watch.active(), undefined);
  bash.finish();
  h.told.length = 0;
  const shell = h.shells.start('pwsh -File scripts/release/deploy-web.ps1', '/project', async () => ({ output: '', failed: false }));
  await h.shells.settle(shell, 5_000);
  assert.deepEqual(h.told, [], 'a shut-down instance no longer listens to the shells');
});
