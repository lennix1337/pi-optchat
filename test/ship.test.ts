import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tempDir } from './support.ts';

// scripts/ship.mjs is exercised through its command line only: real git on a temp clone of a bare origin, and a fake
// `gh` on PATH (test/fixtures/fake-gh.mjs), so every effect that ran is visible in the origin or in the gh log.
const SHIP = fileURLToPath(new URL('../scripts/ship.mjs', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const IDENTITY = { GIT_AUTHOR_NAME: 'Ship Test', GIT_AUTHOR_EMAIL: 'ship@test.invalid', GIT_COMMITTER_NAME: 'Ship Test', GIT_COMMITTER_EMAIL: 'ship@test.invalid' };
const BODY = ['-b', 'Problema: a.txt faltava. Mudança: cria a.txt. Evidência: teste.'];
const PENDING_CI = [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null }];

type Fixture = { dir: string; work: string; origin: string; bin: string; statePath: string; logPath: string; setGh(patch: Record<string, unknown>): void; ghCalls(): string[][]; close(): void };
type Ship = { code: number | null; out: Record<string, string>; raw: string; err: string };

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function fixture(): Fixture {
  const { dir, close } = tempDir('ship-');
  const seed = join(dir, 'seed'), origin = join(dir, 'origin.git'), work = join(dir, 'work'), bin = join(dir, 'bin');
  git(dir, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(dir, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(seed, ['push', '-q', origin, 'main']);
  git(dir, ['clone', '-q', origin, work]);
  git(work, ['switch', '-q', '-c', 'feat/x']);

  mkdirSync(bin);
  const shim = `${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_GH)}`;
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${shim} "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(bin, 'gh.cmd'), `@${shim.replace(/\//g, '\\')} %*\r\n`);

  const statePath = join(dir, 'gh-state.json'), logPath = join(dir, 'gh.log');
  const state = { prs: [], defaults: { mergeStateStatus: 'BLOCKED', checks: PENDING_CI }, autoMerge: 'queue' };
  writeFileSync(statePath, JSON.stringify(state));
  return {
    dir, work, origin, bin, statePath, logPath,
    setGh(patch) { writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), ...patch })); },
    ghCalls() { return existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) : []; },
    close,
  };
}

function envFor(fx: Fixture, extra: Record<string, string> = {}) {
  const env: Record<string, string> = { ...process.env, ...IDENTITY, FAKE_GH_STATE: fx.statePath, FAKE_GH_LOG: fx.logPath, PI_GITWATCH_DIR: join(fx.dir, 'gitwatch'), ...extra } as Record<string, string>;
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = fx.bin + delimiter + (env[pathKey] ?? '');
  return env;
}

function ship(fx: Fixture, args: string[], extra: Record<string, string> = {}, cwd = fx.work): Ship {
  const r = spawnSync(process.execPath, [SHIP, ...args], { cwd, encoding: 'utf8', env: envFor(fx, extra), timeout: 120_000 });
  const out = Object.fromEntries(r.stdout.trim().split('\n').filter(Boolean).map(line => { const i = line.indexOf(': '); return [line.slice(0, i), line.slice(i + 2)]; }));
  return { code: r.status, out, raw: r.stdout, err: r.stderr };
}

const commitFile = (fx: Fixture, name: string, text = `${name}\n`) => { writeFileSync(join(fx.work, name), text); };
const remoteSha = (fx: Fixture, branch: string) => git(fx.work, ['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s/)[0];
const localSha = (fx: Fixture) => git(fx.work, ['rev-parse', 'HEAD']);

test('refuses the default branch without --direct-main, before any effect', t => {
  const fx = fixture(); t.after(fx.close);
  git(fx.work, ['switch', '-q', 'main']);
  commitFile(fx, 'a.txt');
  const before = git(fx.work, ['rev-parse', 'origin/main']);
  const r = ship(fx, ['-m', 'mexe no main', 'a.txt']);
  assert.equal(r.code, 2);
  assert.equal(r.out.status, 'refused');
  assert.equal(r.out.error, 'default_branch');
  // 06/11: the retry with --branch was refused again for the missing description; one refusal names both.
  assert.equal(r.out.also, 'body_required');
  assert.match(String(r.out.hint), /--branch NOME.*--body-file ARQ/);
  assert.equal(ship(fx, ['-m', 'mexe no main', '-b', 'corpo', 'a.txt']).out.also, undefined, 'with a description only the branch is missing');
  assert.equal(git(fx.work, ['diff', '--cached', '--name-only']), '');
  assert.equal(git(fx.work, ['rev-parse', 'origin/main']), before);
  assert.deepEqual(fx.ghCalls(), []);
});

test('the last output line carries the exit code, so a piped run (| tail) still shows it', t => {
  const fx = fixture(); t.after(fx.close);
  git(fx.work, ['switch', '-q', 'main']);
  commitFile(fx, 'a.txt');
  const refused = ship(fx, ['-m', 'mexe no main', 'a.txt']);
  assert.equal(refused.code, 2);
  assert.equal(refused.raw.trimEnd().split('\n').at(-1), 'rc: 2');
  const dry = ship(fx, ['--dry-run', '-m', 'x', '-b', 'corpo', '--branch', 'feat/rc', 'a.txt']);
  assert.equal(dry.code, 0);
  assert.equal(dry.raw.trimEnd().split('\n').at(-1), 'rc: 0');
});

test('--sync returns to the default branch, fast-forwards it and drops the merged local branch', t => {
  const fx = fixture(); t.after(fx.close);
  commitFile(fx, 'a.txt');
  git(fx.work, ['add', '-A']); git(fx.work, ['commit', '-q', '-m', 'feat']);
  git(fx.work, ['push', '-q', 'origin', 'feat/x:main']);
  const r = ship(fx, ['--sync']);
  assert.equal(r.code, 0);
  assert.equal(r.out.status, 'synced');
  assert.equal(r.out.local_branch, 'deleted feat/x');
  assert.equal(git(fx.work, ['branch', '--show-current']), 'main');
  assert.equal(localSha(fx), git(fx.work, ['rev-parse', 'origin/main']));
  assert.equal(r.raw.trimEnd().split('\n').at(-1), 'rc: 0');
});

test('--sync keeps a branch git does not call merged, and refuses a dirty tree before any effect', t => {
  const fx = fixture(); t.after(fx.close);
  commitFile(fx, 'a.txt');
  git(fx.work, ['add', '-A']); git(fx.work, ['commit', '-q', '-m', 'unmerged work']);
  const kept = ship(fx, ['--sync']);
  assert.equal(kept.code, 0);
  assert.equal(kept.out.local_branch, 'kept feat/x');
  assert.match(git(fx.work, ['branch', '--list', 'feat/x']), /feat\/x/);
  git(fx.work, ['switch', '-q', 'feat/x']);
  commitFile(fx, 'dirty.txt');
  const refused = ship(fx, ['--sync']);
  assert.equal(refused.code, 2);
  assert.equal(refused.out.error, 'dirty_tree');
  assert.equal(git(fx.work, ['branch', '--show-current']), 'feat/x');
});

function linkedWorktree(fx: Fixture) {
  git(fx.work, ['switch', '-q', 'main']);
  const wt = join(fx.dir, 'wt');
  git(fx.work, ['worktree', 'add', '-q', wt, '-b', 'feat/wt']);
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  git(wt, ['add', '-A']); git(wt, ['commit', '-q', '-m', 'feat in worktree']);
  git(wt, ['push', '-q', 'origin', 'feat/wt:main']);
  return wt;
}

test('--sync from a linked worktree fast-forwards the main checkout and leaves the worktree alone', t => {
  const fx = fixture(); t.after(fx.close);
  const wt = linkedWorktree(fx);
  const r = ship(fx, ['--sync'], {}, wt);
  assert.equal(r.code, 0, r.raw + r.err);
  assert.equal(r.out.status, 'synced');
  assert.equal(r.out.main_checkout, 'fast-forwarded');
  assert.equal(git(fx.work, ['rev-parse', 'HEAD']), git(fx.work, ['rev-parse', 'origin/main']));
  assert.equal(git(wt, ['branch', '--show-current']), 'feat/wt');
  assert.match(r.out.next, /worktree/);
});

test('--sync from a linked worktree reports a dirty main checkout instead of failing', t => {
  const fx = fixture(); t.after(fx.close);
  const wt = linkedWorktree(fx);
  writeFileSync(join(fx.work, 'dirty.txt'), 'x\n');
  const r = ship(fx, ['--sync'], {}, wt);
  assert.equal(r.code, 0, r.raw + r.err);
  assert.equal(r.out.main_checkout, '"skipped: dirty"');
  assert.notEqual(git(fx.work, ['rev-parse', 'HEAD']), git(fx.work, ['rev-parse', 'origin/main']));
});

test('--sync does not combine with commit or PR options', t => {
  const fx = fixture(); t.after(fx.close);
  for (const extra of [['--all', '-m', 'x'], ['--pr', '3'], ['--direct-main'], ['--branch', 'feat/y']]) {
    const r = ship(fx, ['--sync', ...extra]);
    assert.equal(r.code, 2, extra.join(' '));
    assert.equal(r.out.error, 'conflicting_args');
  }
});

test('refuses flags that would force a push, skip hooks or merge as admin', t => {
  const fx = fixture(); t.after(fx.close);
  for (const flag of ['--force', '-f', '--force-with-lease', '--no-verify', '--admin', '--delete-branch']) {
    const r = ship(fx, ['-m', 'x', 'a.txt', flag]);
    assert.equal(r.code, 2, flag);
    assert.equal(r.out.error, 'unknown_flag', flag);
  }
  assert.deepEqual(fx.ghCalls(), []);
});

test('refuses paths without -m before staging anything', t => {
  const fx = fixture(); t.after(fx.close);
  commitFile(fx, 'a.txt');
  const r = ship(fx, ['a.txt']);
  assert.equal(r.code, 2);
  assert.equal(r.out.error, 'message_required');
  assert.equal(git(fx.work, ['diff', '--cached', '--name-only']), '');
});

test('commits only the selected paths, pushes, opens the PR and queues auto-merge', t => {
  const fx = fixture(); t.after(fx.close);
  commitFile(fx, 'a.txt');
  commitFile(fx, 'b.txt');
  git(fx.work, ['add', 'b.txt']);
  const trace = join(fx.dir, 'trace.log');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt'], { GIT_TRACE2_EVENT: trace });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'queued');
  assert.equal(r.out.branch, 'feat/x');
  assert.equal(r.out.pr, '1');
  assert.equal(r.out.url, '"https://github.com/acme/app/pull/1"', 'a URL holds colons, so it is quoted');
  assert.equal(r.out.auto_merge, 'queued');
  assert.equal(git(fx.work, ['show', '--name-only', '--format=', 'HEAD']), 'a.txt');
  assert.equal(git(fx.work, ['diff', '--cached', '--name-only']), 'b.txt', 'an unrelated staged file stays staged');
  assert.equal(remoteSha(fx, 'feat/x'), localSha(fx));
  const calls = fx.ghCalls().map(args => args.join(' '));
  assert.equal(calls[0], 'pr view feat/x --json number,url,state,mergeStateStatus,autoMergeRequest,statusCheckRollup');
  assert.equal(calls[1], 'pr create --fill --body-file ' + calls[1].split(' ')[4] + ' --base main --head feat/x');
  const state = JSON.parse(readFileSync(fx.statePath, 'utf8'));
  assert.equal(state.prs[0].body, 'Problema: a.txt faltava. Mudança: cria a.txt. Evidência: teste.\n', 'the PR carries the description');
  assert.equal(existsSync(calls[1].split(' ')[4]), false, 'the description file is removed');
  assert.match(git(fx.work, ['log', '-1', '--format=%b']), /Problema: a.txt faltava/, 'the commit carries it too');
  assert.equal(calls.at(-1), 'pr view 1 --json number,url,state,mergeStateStatus,autoMergeRequest,statusCheckRollup');
  assert.ok(calls.includes('pr merge 1 --squash --auto'));
  assert.equal(r.out.gitwatch, 'requested');
  const follow = join(fx.dir, 'gitwatch', 'follow', 'acme__app#1.json');
  assert.deepEqual(JSON.parse(readFileSync(follow, 'utf8')), { repo: 'acme/app', pr: 1 }, 'the poller is asked to follow the PR, so its merge wakes the agent');
  const traced = existsSync(trace) ? readFileSync(trace, 'utf8') : '';
  assert.ok(traced.includes('"commit"'), 'git ran through the trace');
  for (const forbidden of ['--no-verify', '--force', '--admin']) assert.equal(traced.includes(forbidden) || calls.join(' ').includes(forbidden), false, forbidden);
});

test('a new PR without a description is refused before staging, committing or pushing', t => {
  const fx = fixture(); t.after(fx.close);
  commitFile(fx, 'a.txt');
  const r = ship(fx, ['-m', 'feat: a', 'a.txt']);
  assert.equal(r.code, 2);
  assert.equal(r.out.error, 'body_required');
  assert.equal(git(fx.work, ['diff', '--cached', '--name-only']), '');
  assert.equal(git(fx.work, ['ls-remote', 'origin', 'refs/heads/feat/x']), '');
  assert.ok(!fx.ghCalls().some(args => args[1] === 'create'));
  assert.equal(ship(fx, ['-m', 'feat: a', '-b', '  ', 'a.txt']).out.error, 'body_required', 'a blank description is no description');
});

test('--title names the PR when it ships existing commits; a .cmd shim cannot carry free text, so it is refused before anything is created', t => {
  const fx = fixture(); t.after(fx.close);
  writeFileSync(join(fx.work, 'a.txt'), 'a\n');
  git(fx.work, ['add', 'a.txt']); git(fx.work, ['commit', '-q', '-m', 'wip: first']);
  writeFileSync(join(fx.work, 'b.txt'), 'b\n');
  git(fx.work, ['add', 'b.txt']); git(fx.work, ['commit', '-q', '-m', 'wip: second']);
  const r = ship(fx, ['--title', 'feat: relatório com dois commits', ...BODY]);
  if (process.platform === 'win32') {
    assert.equal(r.out.error, 'unsafe_argument', 'the fixture gh.cmd runs through a shell');
    assert.ok(!fx.ghCalls().some(args => args[1] === 'create'));
    return;
  }
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(readFileSync(fx.statePath, 'utf8')).prs[0].title, 'feat: relatório com dois commits');
  assert.equal(ship(fx, ['--title', '  ', ...BODY]).out.error, 'invalid_value');
  assert.equal(ship(fx, ['--title', 'x', '--pr', '1']).out.error, 'conflicting_args');
});

test('a re-run reuses the open PR and creates nothing', t => {
  const fx = fixture(); t.after(fx.close);
  fx.setGh({ prs: [{ number: 7, url: 'https://github.com/acme/app/pull/7', state: 'OPEN', headRefName: 'feat/x', mergeStateStatus: 'BLOCKED', autoMergeRequest: null, statusCheckRollup: PENDING_CI }] });
  git(fx.work, ['push', '-q', '-u', 'origin', 'feat/x']);
  const r = ship(fx, []);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'queued');
  assert.equal(r.out.pr, '7');
  assert.equal(r.out.push, 'up_to_date');
  assert.equal(r.out.commit, undefined);
  assert.ok(!fx.ghCalls().some(args => args[1] === 'create'));
});

test('--pr queues auto-merge of an existing PR without git or PR creation', t => {
  const fx = fixture(); t.after(fx.close);
  fx.setGh({ prs: [{ number: 9, url: 'https://github.com/acme/app/pull/9', state: 'OPEN', headRefName: 'feat/y', mergeStateStatus: 'BLOCKED', autoMergeRequest: null, statusCheckRollup: PENDING_CI }] });
  const r = ship(fx, ['--pr', '9']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'queued');
  assert.deepEqual(fx.ghCalls().map(args => args.slice(0, 2).join(' ')), ['pr view', 'pr merge', 'pr view']);
});

test('checks not reported yet, and a merge that would land at once: reported, not queued', t => {
  const fx = fixture(); t.after(fx.close);
  fx.setGh({ defaults: { mergeStateStatus: 'CLEAN', checks: [] } });
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt', '--wait', '1']);
  assert.equal(r.code, 3);
  assert.equal(r.out.status, 'not_queued');
  assert.equal(r.out.reason, 'checks_not_reported');
  assert.equal(r.out.checks, 'none reported');
  assert.match(r.out.next, /--pr 1/);
  assert.ok(!fx.ghCalls().some(args => args[1] === 'merge'), 'no merge request is sent');
});

test('a PR whose checks show up a moment after it opens is re-read within a second, not after a long pause', t => {
  const fx = fixture(); t.after(fx.close);
  fx.setGh({ defaults: { mergeStateStatus: 'CLEAN', checks: [] }, settleAfterViews: { count: 1, patch: { mergeStateStatus: 'BLOCKED', statusCheckRollup: PENDING_CI } } });
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt']);
  assert.equal(r.out.status, 'queued', r.err);
  const times: number[] = JSON.parse(readFileSync(fx.statePath, 'utf8')).viewTimes;
  assert.ok(times.length >= 2, 'the PR was read again');
  assert.ok(times[1] - times[0] < 1800, `second read came ${times[1] - times[0]} ms after the first`);
});

test('CLEAN with checks still running would merge at once, so it is not queued', t => {
  const fx = fixture(); t.after(fx.close);
  fx.setGh({ defaults: { mergeStateStatus: 'CLEAN', checks: PENDING_CI } });
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt']);
  assert.equal(r.code, 3);
  assert.equal(r.out.reason, 'merge_would_be_immediate');
  assert.equal(r.out.checks, '0 pass / 1 pending / 0 fail');
  assert.ok(!fx.ghCalls().some(args => args[1] === 'merge'));

  // Without a required check GitHub never queues: repeating --pr cannot help, so the hint names the merge that can.
  assert.doesNotMatch(r.out.next, /ship\.mjs --pr/);
  assert.match(r.out.next, /gh pr merge 1 --squash/);
});

test('a failing check is reported and blocks the queue', t => {
  const fx = fixture(); t.after(fx.close);
  fx.setGh({ defaults: { mergeStateStatus: 'BLOCKED', checks: [{ __typename: 'CheckRun', name: 'billing', status: 'COMPLETED', conclusion: 'FAILURE' }, { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] } });
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt']);
  assert.equal(r.code, 3);
  assert.equal(r.out.reason, 'checks_failed');
  assert.equal(r.out.detail, 'billing');
  assert.ok(!fx.ghCalls().some(args => args[1] === 'merge'));
});

test('a repository that disables auto-merge is reported as not queued', t => {
  const fx = fixture(); t.after(fx.close);
  fx.setGh({ autoMerge: 'disabled' });
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt']);
  assert.equal(r.code, 3);
  assert.equal(r.out.status, 'not_queued');
  assert.equal(r.out.reason, 'auto_merge_disabled');
  assert.equal(r.out.pr, '1', 'the PR is open even though auto-merge is not queued');
});

test('--no-auto opens the PR and leaves auto-merge alone', t => {
  const fx = fixture(); t.after(fx.close);
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt', '--no-auto']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'pr_open');
  assert.equal(r.out.auto_merge, 'skipped');
  assert.ok(!fx.ghCalls().some(args => args[1] === 'merge'));
});

test('a push the remote rejects fails without force, and opens no PR', t => {
  const fx = fixture(); t.after(fx.close);
  commitFile(fx, 'a.txt');
  git(fx.work, ['add', 'a.txt']);
  git(fx.work, ['commit', '-q', '-m', 'first']);
  git(fx.work, ['push', '-q', '-u', 'origin', 'feat/x']);
  const other = join(fx.dir, 'other');
  git(fx.dir, ['clone', '-q', fx.origin, other]);
  git(other, ['switch', '-q', 'feat/x']);
  writeFileSync(join(other, 'c.txt'), 'remote\n');
  git(other, ['add', 'c.txt']);
  git(other, ['commit', '-q', '-m', 'remote work']);
  git(other, ['push', '-q', 'origin', 'feat/x']);
  const remoteBefore = remoteSha(fx, 'feat/x');
  commitFile(fx, 'b.txt');
  const r = ship(fx, [...BODY, '-m', 'local work', 'b.txt']);
  assert.equal(r.code, 1);
  assert.equal(r.out.status, 'failed');
  assert.equal(r.out.stage, 'push');
  assert.equal(remoteSha(fx, 'feat/x'), remoteBefore, 'the remote branch is untouched');
  assert.ok(!fx.ghCalls().some(args => args[1] === 'create'));
});

test('a failing pre-commit hook stops before any push', t => {
  const fx = fixture(); t.after(fx.close);
  writeFileSync(join(fx.work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint falhou" >&2\nexit 1\n');
  chmodSync(join(fx.work, '.git', 'hooks', 'pre-commit'), 0o755);
  commitFile(fx, 'a.txt');
  const before = remoteSha(fx, 'feat/x');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt']);
  assert.equal(r.code, 1);
  assert.equal(r.out.stage, 'commit');
  assert.equal(remoteSha(fx, 'feat/x'), before);
  assert.ok(!fx.ghCalls().some(args => args[1] === 'create' || args[1] === 'merge'), 'only the read-only PR lookup ran');
});

test('--direct-main pushes the default branch with no PR', t => {
  const fx = fixture(); t.after(fx.close);
  git(fx.work, ['switch', '-q', 'main']);
  commitFile(fx, 'a.txt');
  const r = ship(fx, ['-m', 'docs: a', 'a.txt', '--direct-main']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'pushed');
  assert.equal(r.out.branch, 'main');
  assert.equal(remoteSha(fx, 'main'), localSha(fx));
  assert.deepEqual(fx.ghCalls(), []);
});

test('a PR create that times out is reconciled and not replayed', t => {
  const fx = fixture(); t.after(fx.close);
  fx.setGh({ createHangs: true });
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt'], { SHIP_TIMEOUT_MS: '1500' });
  assert.equal(r.code, 4);
  assert.equal(r.out.status, 'uncertain');
  assert.equal(r.out.stage, 'pr_create');
  assert.equal(fx.ghCalls().filter(args => args[1] === 'create').length, 1, 'the create ran once, not replayed');
});

test('a slow pre-commit hook is not killed by the short local timeout', t => {
  const fx = fixture(); t.after(fx.close);
  const hook = join(fx.work, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nsleep 3\n');
  chmodSync(hook, 0o755);
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt'], { SHIP_TIMEOUT_MS: '1500' });
  assert.notEqual(r.out.stage, 'commit', r.raw + r.err);
  assert.equal(git(fx.work, ['log', '-1', '--format=%s']), 'feat: a');
});

test('a commit that outlives its own timeout stays uncertain', t => {
  const fx = fixture();
  const hook = join(fx.work, '.git', 'hooks', 'pre-commit');
  const finished = join(fx.work, '.git', 'hook-finished');
  // The killed commit leaves the hook's `sleep` running inside the work tree; on Windows that holds the directory (EBUSY on cleanup in CI), so cleanup waits for the hook to end first.
  t.after(() => {
    for (let i = 0; i < 100 && !existsSync(finished); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    fx.close();
  });
  writeFileSync(hook, '#!/bin/sh\nsleep 5\ntouch "$(git rev-parse --git-dir)/hook-finished"\n');
  chmodSync(hook, 0o755);
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt'], { SHIP_COMMIT_TIMEOUT_MS: '1500' });
  assert.equal(r.code, 4);
  assert.equal(r.out.stage, 'commit');
});

test('dry-run prints the plan and runs no effect', t => {
  const fx = fixture(); t.after(fx.close);
  commitFile(fx, 'a.txt');
  const before = remoteSha(fx, 'feat/x');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'dry_run');
  assert.match(r.out.plan, /stage a\.txt > commit > push feat\/x > abrir PR > auto-merge/);
  assert.equal(git(fx.work, ['diff', '--cached', '--name-only']), '');
  assert.equal(remoteSha(fx, 'feat/x'), before);
  assert.ok(!fx.ghCalls().some(args => args[1] === 'create' || args[1] === 'merge'));
});

test('nothing to ship is refused, not sent as an empty PR', t => {
  const fx = fixture(); t.after(fx.close);
  const r = ship(fx, BODY);
  assert.equal(r.code, 2);
  assert.equal(r.out.error, 'nothing_to_ship');
  assert.ok(!fx.ghCalls().some(args => args[1] === 'create' || args[1] === 'merge'), 'only the read-only PR lookup ran');
});

test('help prints usage and exits 0', t => {
  const fx = fixture(); t.after(fx.close);
  const r = ship(fx, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.raw, /node scripts\/ship\.mjs/);
});

test('--branch creates the branch from the default branch with the working changes and ships through it', t => {
  const fx = fixture(); t.after(fx.close);
  git(fx.work, ['switch', '-q', 'main']);
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt', '--branch', 'feat/novo']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.branch, 'feat/novo');
  assert.equal(git(fx.work, ['branch', '--show-current']), 'feat/novo');
  assert.equal(git(fx.work, ['rev-parse', 'main']), git(fx.work, ['rev-parse', 'origin/main']), 'main stays untouched');
  assert.ok(remoteSha(fx, 'feat/novo'));
});

test('--branch dry-run plans the branch and creates nothing', t => {
  const fx = fixture(); t.after(fx.close);
  git(fx.work, ['switch', '-q', 'main']);
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt', '--branch', 'feat/novo', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.plan, /^criar branch feat\/novo > stage a\.txt/);
  assert.equal(git(fx.work, ['branch', '--show-current']), 'main');
});

test('--branch is refused off the default branch and when the name exists', t => {
  const fx = fixture(); t.after(fx.close);
  commitFile(fx, 'a.txt');
  const off = ship(fx, [...BODY, '-m', 'x', 'a.txt', '--branch', 'feat/outra']);
  assert.equal(off.code, 2);
  assert.equal(off.out.error, 'branch_flag_not_on_base');
  git(fx.work, ['switch', '-q', 'main']);
  const dup = ship(fx, [...BODY, '-m', 'x', 'a.txt', '--branch', 'feat/x']);
  assert.equal(dup.code, 2);
  assert.equal(dup.out.error, 'branch_exists');
  assert.equal(git(fx.work, ['branch', '--show-current']), 'main');
});

test('a leftover .git/index.lock is reported as a lock, not as bad paths', t => {
  const fx = fixture(); t.after(fx.close);
  commitFile(fx, 'a.txt');
  writeFileSync(join(fx.work, '.git', 'index.lock'), '');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt']);
  assert.equal(r.code, 1);
  assert.equal(r.out.stage, 'stage');
  assert.match(r.out.next, /index\.lock/);
  assert.match(r.out.next, /nenhum processo git|processo git/i);
  assert.doesNotMatch(r.out.next, /confira os nomes/);
});

test('a shipped branch reports where the time went: commit, push, gh', t => {
  const fx = fixture(); t.after(fx.close);
  git(fx.work, ['switch', '-c', 'feat/timing']);
  commitFile(fx, 'a.txt');
  const r = ship(fx, [...BODY, '-m', 'feat: a', 'a.txt']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.timing ?? '', /^"?commit \d+ms, push \d+ms, gh \d+ms, total \d+ms"?$/, r.raw);
});
