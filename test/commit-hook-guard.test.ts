import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { MIN_COMMIT_HOOK_TIMEOUT_SECONDS, activePreCommitHook, hookedCommit, registerCommitHookGuard } from '../src/commit-hook-guard.ts';
import { removeDir } from './support.ts';

// Session 2026-10-30: husky's pre-commit in dentai-mono runs the full api and web suites (minutes). A foreground
// `git add && git commit && git push && gh pr create` with timeout 180 outlived its bash call; the commit's outcome was
// left uncertain and every later bash call was refused until reconciled by hand. The guard refuses that call before it runs.

const slash = (path: string) => path.replaceAll('\\', '/');
const same = (a: string | undefined, b: string) => a !== undefined && slash(a).toLowerCase() === slash(b).toLowerCase();

function git(dir: string, ...args: string[]) {
  execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
}
/** A repository with one commit made before any hook exists, so the setup commit runs none. */
function repo(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}
function write(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  return file;
}

function fixtures() {
  const root = mkdtempSync(join(tmpdir(), 'commit-hook-'));
  const gitHook = repo(root, 'git-hook');
  write(join(gitHook, '.git', 'hooks', 'pre-commit'));
  const husky = repo(root, 'husky');
  write(join(husky, '.husky', 'pre-commit'));
  const hooksPath = repo(root, 'hooks-path');
  git(hooksPath, 'config', 'core.hooksPath', '.husky/_');
  write(join(hooksPath, '.husky', '_', 'pre-commit'));
  const plain = repo(root, 'plain');
  const worktree = join(root, 'worktree-of-git-hook');
  git(gitHook, 'worktree', 'add', '-q', '-b', 'feat/x', worktree);
  return { root, gitHook, husky, hooksPath, plain, worktree };
}

test('a pre-commit hook is found where git runs one, and a sample hook is not', () => {
  const f = fixtures();
  try {
    assert.ok(same(activePreCommitHook(f.gitHook), join(f.gitHook, '.git', 'hooks', 'pre-commit')));
    assert.ok(same(activePreCommitHook(f.husky), join(f.husky, '.husky', 'pre-commit')));
    assert.ok(same(activePreCommitHook(f.hooksPath), join(f.hooksPath, '.husky', '_', 'pre-commit')));
    assert.ok(same(activePreCommitHook(f.worktree), join(f.gitHook, '.git', 'hooks', 'pre-commit')), 'a linked worktree shares its repository hooks');
    assert.equal(activePreCommitHook(f.plain), undefined, 'git init leaves only pre-commit.sample');
    assert.equal(activePreCommitHook(join(f.root, 'not-a-repo')), undefined);
  } finally { removeDir(f.root); }
});

test('a commit in a repo with a hook is found, wherever the directory comes from', () => {
  const f = fixtures();
  try {
    assert.ok(hookedCommit('git commit -m "feat: x"', f.husky));
    assert.ok(hookedCommit(`cd ${slash(f.husky)} && git add -A && git commit -m "feat: x" && git push`, f.plain));
    assert.ok(hookedCommit(`git -C ${slash(f.husky)} commit -m x`, f.plain));
    assert.ok(hookedCommit('git commit -m x', f.worktree));
    assert.ok(hookedCommit('git -c core.quotepath=off commit -m x', f.gitHook));
    assert.equal(hookedCommit('git commit -m x', f.plain), undefined, 'a repo without a hook is not affected');
    assert.equal(hookedCommit(`git -C ${slash(f.plain)} commit -m x`, f.husky), undefined);
    assert.equal(hookedCommit('git commit -m x', join(f.root, 'not-a-repo')), undefined);
  } finally { removeDir(f.root); }
});

test('the exemptions and non-commit commands do not count', () => {
  const f = fixtures();
  try {
    assert.equal(hookedCommit('git commit --no-verify -m x', f.husky), undefined);
    assert.equal(hookedCommit('git commit -n -m x', f.husky), undefined);
    assert.equal(hookedCommit('git commit --dry-run -m x', f.husky), undefined);
    assert.equal(hookedCommit('git status && git log --oneline -3', f.husky), undefined);
    assert.equal(hookedCommit('grep -n "git commit" docs/notes.md', f.husky), undefined);
    assert.equal(hookedCommit('cat > /tmp/x.md <<\'EOF\'\ngit commit -m x\nEOF', f.husky), undefined, 'a heredoc body is data');
  } finally { removeDir(f.root); }
});

function harness(active: string[] = ['bash', 'shell_start']) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const pi = { on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); }, getActiveTools: () => active } as unknown as ExtensionAPI;
  registerCommitHookGuard(pi);
  return (command: string, options: { timeout?: number | null; toolName?: string; cwd: string }) => hooks.get('tool_call')!(
    { toolName: options.toolName ?? 'bash', toolCallId: 'c', input: { command, timeout: options.timeout } }, { cwd: options.cwd }) as { block: true; reason: string } | undefined;
}

test('a foreground commit in a hooked repo with a short timeout is refused before it runs', () => {
  const f = fixtures();
  try {
    const call = harness();
    const command = `git add apps && git commit -m "feat: x" && git push -u origin HEAD`;
    for (const timeout of [180, 899]) {
      const blocked = call(command, { timeout, cwd: f.husky });
      assert.equal(blocked?.block, true, `timeout ${timeout}`);
      assert.match(blocked!.reason, /shell_start/);
      assert.match(blocked!.reason, new RegExp(`at least ${MIN_COMMIT_HOOK_TIMEOUT_SECONDS} s`));
      assert.match(blocked!.reason, /pre-commit/);
    }
  } finally { removeDir(f.root); }
});

test('a timeout of at least 900 s, a repo without hooks, and other tools are not affected', () => {
  const f = fixtures();
  try {
    const call = harness();
    assert.equal(MIN_COMMIT_HOOK_TIMEOUT_SECONDS, 900);
    assert.equal(call('git commit -m x', { timeout: 900, cwd: f.husky }), undefined);
    assert.equal(call('git commit -m x', { timeout: 1800, cwd: f.husky }), undefined);
    // Pi's bash tool has no default timeout: without one the call waits for the hook, however long it runs.
    assert.equal(call('git commit -m x', { timeout: undefined, cwd: f.husky }), undefined, 'no timeout');
    assert.equal(call('git commit -m x', { timeout: null, cwd: f.husky }), undefined, 'null timeout');
    assert.equal(call('git commit -m x', { timeout: 180, cwd: f.plain }), undefined);
    assert.equal(call('git commit -m x', { timeout: 180, cwd: f.husky, toolName: 'shell_start' }), undefined, 'a background shell waits for nothing');
    assert.equal(call('git status', { timeout: 60, cwd: f.husky }), undefined);
  } finally { removeDir(f.root); }
});

test('without shell_start the refusal still names the timeout alternative', () => {
  const f = fixtures();
  try {
    const blocked = harness(['bash'])('git commit -m x', { timeout: 180, cwd: f.husky });
    assert.equal(blocked?.block, true);
    assert.doesNotMatch(blocked!.reason, /shell_start/);
    assert.match(blocked!.reason, /timeout of at least 900 s/);
  } finally { removeDir(f.root); }
});
