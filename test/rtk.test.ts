import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactCommand, isEmptyGrepMiss, type RewriteRunner } from '../src/rtk.ts';
import { longCommandReason } from '../src/long-commands.ts';

const runner = (code: number | null, stdout: string): RewriteRunner => async () => ({ code, stdout });

test('a command rtk handles runs in its compact form', async () => {
  assert.equal(await compactCommand('git log -10', false, runner(0, 'rtk git log -10')), 'rtk git log -10');
  assert.equal(await compactCommand('git status && git log -3', false, runner(3, 'rtk git status && rtk git log -3\n')), 'rtk git status && rtk git log -3');
});

test('full_output, no rewrite, a missing rtk or an unknown exit run the command as written', async () => {
  let asked = false;
  const spy: RewriteRunner = async () => { asked = true; return { code: 0, stdout: 'rtk git log' }; };
  assert.equal(await compactCommand('git log', true, spy), 'git log');
  assert.equal(asked, false);
  assert.equal(await compactCommand('sed -n 1,5p a.ts', false, runner(1, '')), 'sed -n 1,5p a.ts');
  assert.equal(await compactCommand('git log', false, async () => undefined), 'git log');
  assert.equal(await compactCommand('git log', false, runner(null, 'rtk git log')), 'git log');
  assert.equal(await compactCommand('git log', false, runner(2, 'rtk git log')), 'git log');
});

test('rewrites that drop paths or file names are refused', async () => {
  // Measured 14/11: `rtk find src -name "*.ts"` prints `a.ts` for `src/a.ts`; `rtk wc -l f` prints the count without `f`.
  assert.equal(await compactCommand('find src -name "*.ts"', false, runner(0, 'rtk find src -name "*.ts"')), 'find src -name "*.ts"');
  assert.equal(await compactCommand('wc -l a.ts', false, runner(0, 'rtk wc -l a.ts')), 'wc -l a.ts');
  assert.equal(await compactCommand('cd x && find . | head', false, runner(0, 'cd x && rtk find . | head')), 'cd x && find . | head');
  // Measured 14/11: `rtk git show HEAD:src/index.ts` printed 115 of 1,512 lines; reading a file at a revision needs it whole.
  assert.equal(await compactCommand('git show HEAD:src/a.ts', false, runner(0, 'rtk git show HEAD:src/a.ts')), 'git show HEAD:src/a.ts');
  assert.equal(await compactCommand('git show main~2:a.ts', false, runner(0, 'rtk git show main~2:a.ts')), 'git show main~2:a.ts');
  assert.equal(await compactCommand('git show HEAD --stat', false, runner(0, 'rtk git show HEAD --stat')), 'rtk git show HEAD --stat');
});

test('the long-command mover still recognizes a build behind rtk', () => {
  assert.equal(longCommandReason('rtk cargo test'), longCommandReason('cargo test'));
  assert.ok(longCommandReason('rtk cargo test'));
});

test('grep that matched nothing is an empty answer, not an error', () => {
  assert.equal(isEmptyGrepMiss('grep -n foo src/a.ts', 1, ''), true);
  assert.equal(isEmptyGrepMiss('cd repo && rtk grep -rn foo src', 1, '\n'), true);
  assert.equal(isEmptyGrepMiss('ls | grep index', 1, ''), true);
  assert.equal(isEmptyGrepMiss('LC_ALL=C git grep foo', 1, ''), true);
  assert.equal(isEmptyGrepMiss('/usr/bin/grep.exe foo a', 1, ''), true);
});

test('real failures stay errors', () => {
  assert.equal(isEmptyGrepMiss('grep foo missing.ts', 2, 'grep: missing.ts: No such file or directory'), false);
  assert.equal(isEmptyGrepMiss('grep -c foo a.ts', 1, '0'), false);
  assert.equal(isEmptyGrepMiss('grep foo a.ts | head', 1, ''), false);
  assert.equal(isEmptyGrepMiss('grep foo a.ts && npm test', 1, ''), false);
  assert.equal(isEmptyGrepMiss('test -f a.ts', 1, ''), false);
});

test('the bash tool compacts by default, runs as written with full_output, and answers a grep miss without an error', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const { registerReapingBash } = await import('../src/shell-reaper.ts');
  const tools = new Map<string, any>();
  registerReapingBash({ registerTool: (tool: any) => tools.set(tool.name, tool), on: () => {} } as any);
  const bash = tools.get('bash');
  assert.ok(bash.parameters.properties.full_output);
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'session', getSessionFile: () => undefined } } as any;
  const text = (result: any) => result.content.map((part: any) => part.text).join('');
  const miss = await bash.execute('miss', { command: 'grep -n zz_no_such_text_zz package.json' }, undefined, undefined, ctx);
  assert.equal(miss.isError, false);
  assert.match(text(miss), /no matches/);
  assert.equal(miss.structuredContent.exit_code, 1);
  const broken = await bash.execute('broken', { command: 'grep -n x no-such-file.txt' }, undefined, undefined, ctx);
  assert.equal(broken.isError, true);
  const full = await bash.execute('full', { command: 'ls -la src', full_output: true }, undefined, undefined, ctx);
  const compact = await bash.execute('compact', { command: 'ls -la src' }, undefined, undefined, ctx);
  assert.match(text(full), /rw/);
  assert.ok(text(compact).length <= text(full).length);
});

test('rtk runs quiet and without telemetry unless the user set otherwise', async () => {
  const { prepareRtkEnvironment } = await import('../src/rtk.ts');
  const env: NodeJS.ProcessEnv = { RTK_TELEMETRY_DISABLED: '0' };
  prepareRtkEnvironment(env);
  assert.equal(env.RTK_SUPPRESS_HOOK_WARNING, '1');
  assert.equal(env.RTK_TELEMETRY_DISABLED, '0');
});
