import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEffects, decide, parseContract, type Effect, type Repo } from '../src/autonomy.ts';
import { branchMerged, type Runner } from '../src/merged-branch.ts';

// 09/11: right after PR #26 of pi-gitwatch was squash-merged, deleting its branch and worktree waited for the operator.
const COMMAND = 'cd C:/projetos/pi-gitwatch && git worktree remove worktrees/prunable-cleanup; git worktree prune; git branch -D fix/prunable-worktree-cleanup';
const MERGED_BRANCH = 'fix/prunable-worktree-cleanup';

/** The discard rules of the operator's autonomy.json (profile swlucas05, default advisor) with a strict fallback behind them. */
const CONTRACT = parseContract({
  version: 1, default: 'advisor', rules: [
    { action: 'discard', scope: ['worktree-cleanup'], level: 'free', note: 'merged worktrees may always go' },
    { action: 'discard', scope: ['candidate/*', 'merged-branch'], level: 'free', note: 'merged branches are recreatable' },
    { action: 'discard', scope: ['*'], level: 'ask', note: 'discarding work needs an OK' },
  ],
});

const repoWith = (overrides: Partial<Repo>): Repo => ({ slug: () => 'lennix1337/pi-gitwatch', branch: () => 'main', ...overrides });
const merged = (...names: string[]) => repoWith({ merged: (_path, branch) => names.includes(branch) });
const levelOf = (command: string, repo: Repo, cwd = 'C:/projetos/x') => {
  const effects = classifyEffects({ tool: 'bash', input: { command }, cwd }, repo);
  return { effects, level: decide(CONTRACT, effects).level };
};
const targets = (effects: Effect[]) => effects.map(e => `${e.action} ${e.targets.join(',')}`);

test('deleting a branch already merged (squash, by PR head SHA) is free under the operator rules, with the worktree removal and prune of the same command', () => {
  const { effects, level } = levelOf(COMMAND, merged(MERGED_BRANCH));
  assert.deepEqual(targets(effects), [`discard c:/projetos/pi-gitwatch,merged-branch`]);
  assert.equal(level, 'free');
});

test('a branch not merged, or whose state cannot be read, stays a plain discard that waits', () => {
  for (const repo of [merged('other'), repoWith({}), repoWith({ merged: () => { throw new Error('gh: timeout'); } })]) {
    const { effects, level } = levelOf(COMMAND, repo);
    assert.deepEqual(targets(effects), ['discard c:/projetos/pi-gitwatch']);
    assert.equal(level, 'ask');
  }
});

test('with several branches, every one must be merged; flags other than -D keep the call strict', () => {
  const repo = merged('a', 'b');
  assert.equal(levelOf('git branch -D a b', repo).level, 'free');
  assert.equal(levelOf('git branch -D a c', repo).level, 'ask');
  assert.equal(levelOf('git branch -D -r a', repo).level, 'ask');
  assert.equal(levelOf('git branch -D', repo).level, 'ask');
  assert.equal(levelOf('git branch -D main', merged('main')).level, 'ask', 'the default branch always waits');
});

test('git worktree remove --force frees only a clean worktree whose branch is merged', () => {
  const worktree = (branch: string, clean: boolean) => repoWith({ merged: (_p, b) => b === 'done', worktree: path => path === 'c:/projetos/pi-gitwatch/worktrees/prunable-cleanup' ? { branch, clean } : undefined });
  const remove = 'cd C:/projetos/pi-gitwatch && git worktree remove --force worktrees/prunable-cleanup';
  const free = levelOf(remove, worktree('done', true));
  assert.deepEqual(targets(free.effects), ['discard c:/projetos/pi-gitwatch,worktree-cleanup']);
  assert.equal(free.level, 'free');
  assert.equal(levelOf(remove, worktree('done', false)).level, 'ask', 'uncommitted or untracked files');
  assert.equal(levelOf(remove, worktree('open', true)).level, 'ask', 'branch not merged');
  assert.equal(levelOf(remove, worktree('HEAD', true)).level, 'ask', 'detached head');
  assert.equal(levelOf('cd C:/projetos/pi-gitwatch && git worktree remove --force worktrees/elsewhere', worktree('done', true)).level, 'ask', 'unknown worktree');
  assert.equal(levelOf(remove, repoWith({})).level, 'ask', 'a repo that cannot tell');
});

test('the other discards are untouched by the merged lookup', () => {
  const repo = merged('a');
  for (const command of ['git reset --hard origin/main', 'git clean -fdx', 'git stash drop', 'git push origin --delete a'])
    assert.equal(levelOf(command, repo).level, 'ask', command);
});

// branchMerged: the lookup behind Repo.merged, with the git/gh processes replaced by a script.
const TIP = 'a'.repeat(40);
const script = (answers: Record<string, string | Error>): Runner => (command, args) => {
  const answer = answers[`${command} ${args.join(' ')}`];
  if (answer instanceof Error) throw answer;
  return answer;
};
const base: Record<string, string | Error> = {
  'git rev-parse --verify --quiet refs/heads/feat/x': TIP,
  'git symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
};
const prList = 'gh pr list --head feat/x --state merged --json headRefOid,baseRefName --limit 10';

test('branchMerged: the tip reachable from origin\'s default branch', () => {
  assert.equal(branchMerged('/r', 'feat/x', script({ ...base, [`git merge-base --is-ancestor ${TIP} origin/main`]: '' })), true);
});

test('branchMerged: a merged PR whose head is the local tip (squash merge), into the default branch only', () => {
  const run = (prs: unknown) => script({ ...base, [`git merge-base --is-ancestor ${TIP} origin/main`]: new Error('exit 1'), [prList]: JSON.stringify(prs) });
  assert.equal(branchMerged('/r', 'feat/x', run([{ headRefOid: TIP, baseRefName: 'main' }])), true);
  assert.equal(branchMerged('/r', 'feat/x', run([{ headRefOid: 'b'.repeat(40), baseRefName: 'main' }])), false, 'commits pushed after the PR head');
  assert.equal(branchMerged('/r', 'feat/x', run([{ headRefOid: TIP, baseRefName: 'feat/base' }])), false, 'merged into another feature branch');
  assert.equal(branchMerged('/r', 'feat/x', run([])), false);
  assert.equal(branchMerged('/r', 'feat/x', run('not json')), false);
});

test('branchMerged: any failure of the lookup is "not merged"', () => {
  const ancestor = `git merge-base --is-ancestor ${TIP} origin/main`;
  assert.equal(branchMerged('/r', 'feat/x', script({ ...base, [ancestor]: new Error('exit 1'), [prList]: new Error('gh: timeout') })), false);
  assert.equal(branchMerged('/r', 'feat/x', script({ ...base, [ancestor]: new Error('exit 1') })), false, 'gh printed nothing');
  assert.equal(branchMerged('/r', 'feat/x', script({})), false, 'no such branch');
  assert.equal(branchMerged('/r', 'main', script({ ...base, 'git rev-parse --verify --quiet refs/heads/main': TIP })), false, 'the default branch is never "merged"');
});

test('gitRepo.merged on a real repository: reachable from origin/main is merged, a branch with its own commit is not (no gh needed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-branch-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const origin = join(dir, 'origin.git'), clone = join(dir, 'clone');
    mkdirSync(origin);
    git(origin, 'init', '--bare', '-b', 'main');
    git(dir, 'clone', origin, clone);
    writeFileSync(join(clone, 'a.txt'), '1');
    git(clone, 'add', '.'); git(clone, 'commit', '-m', 'one'); git(clone, 'push', 'origin', 'HEAD:main'); git(clone, 'fetch', 'origin');
    git(clone, 'remote', 'set-head', 'origin', 'main');
    git(clone, 'branch', 'landed');
    git(clone, 'checkout', '-b', 'wip');
    writeFileSync(join(clone, 'b.txt'), '2');
    git(clone, 'add', '.'); git(clone, 'commit', '-m', 'two');
    const noGh: Runner = (command, args, cwd) => command === 'gh' ? undefined : execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    assert.equal(branchMerged(clone, 'landed', noGh), true);
    assert.equal(branchMerged(clone, 'wip', noGh), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
