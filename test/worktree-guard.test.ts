import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeRemovalRefusal, worktreeRemovalTargets } from '../src/worktree-guard.ts';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'worktree-guard-'));
  const repo = join(root, 'repo'), tree = join(root, 'tree'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'base'); git('add', 'file'); git('commit', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('worktree', 'add', '-b', 'feature', tree); writeFileSync(join(tree, 'file'), 'feature');
  execFileSync('git', ['-C', tree, 'commit', '-am', 'feature'], { stdio: 'pipe' });
  return { root, repo, tree, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the gate refuses an unmerged worktree removal whatever the contract says', async () => {
  const f = fixture();
  try {
    const hooks = new Map<string, (...args: any[]) => any>();
    registerEffectApprovals({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI,
      { enabled: true });
    const result = await hooks.get('tool_call')!({ toolName: 'bash', input: { command: `git -C "${f.repo}" worktree remove -f "${f.tree}"` } }, { cwd: f.repo });
    assert.match(result.reason, /feature.*explicit order/i);
  } finally { f.cleanup(); }
});

test('unmerged forced worktree removal is blocked, ancestor and squash merge are allowed', () => {
  const f = fixture();
  try {
    const cmd = `git -C "${f.repo}" worktree remove -f "${f.tree}"`;
    assert.match(worktreeRemovalRefusal(cmd, f.repo, () => false)!, /feature.*explicit order/i);
    assert.match(worktreeRemovalRefusal(`rm -rf "${f.tree}"`, f.repo, () => false)!, /feature/);
    assert.equal(worktreeRemovalRefusal(cmd, f.repo, () => true), undefined);
    f.git('update-ref', 'refs/remotes/origin/main', 'feature');
    assert.equal(worktreeRemovalRefusal(cmd, f.repo, () => false), undefined);
    assert.equal(worktreeRemovalRefusal('rm -rf unrelated', f.repo, () => false), undefined);
    assert.equal(worktreeRemovalTargets('git worktree remove tree', f.repo).length, 0);
  } finally { f.cleanup(); }
});

test('a clean worktree whose HEAD is on a remote-tracking ref may go; a dirty one or one with commits on no remote may not', () => {
  const f = fixture();
  try {
    const remove = (path: string) => `git -C "${f.repo}" worktree remove -f "${path}"`;
    assert.match(worktreeRemovalRefusal(remove(f.tree), f.repo, () => false)!, /feature/, 'commit on no remote');
    f.git('update-ref', 'refs/remotes/origin/feature', 'feature');
    writeFileSync(join(f.tree, 'scratch.txt'), 'untracked');
    assert.match(worktreeRemovalRefusal(remove(f.tree), f.repo, () => false)!, /feature/, 'pushed but dirty (untracked)');
    rmSync(join(f.tree, 'scratch.txt'));
    writeFileSync(join(f.tree, 'file'), 'edited');
    assert.match(worktreeRemovalRefusal(remove(f.tree), f.repo, () => false)!, /feature/, 'pushed but dirty (tracked)');
    writeFileSync(join(f.tree, 'file'), 'feature');
    assert.equal(worktreeRemovalRefusal(remove(f.tree), f.repo, () => false), undefined, 'clean and pushed');
    assert.equal(worktreeRemovalRefusal(`rm -rf "${f.tree}"`, f.repo, () => false), undefined, 'rm -rf of the same clean pushed worktree');
    // A detached gate worktree at a pushed PR head.
    const gate = join(f.root, 'gate');
    f.git('worktree', 'add', '--detach', gate, 'feature');
    assert.equal(worktreeRemovalRefusal(remove(gate), f.repo, () => false), undefined, 'detached at a pushed head');
    execFileSync('git', ['-C', gate, 'commit', '--allow-empty', '-m', 'local only'], { stdio: 'pipe' });
    assert.match(worktreeRemovalRefusal(remove(gate), f.repo, () => false)!, /detached HEAD/, 'detached with a commit on no remote');
  } finally { f.cleanup(); }
});

test('removing a folder that holds unmerged worktrees is blocked', () => {
  const f = fixture();
  try {
    const nested = join(f.repo, '.worktrees', 'nested');
    f.git('worktree', 'add', '-b', 'nested', nested);
    writeFileSync(join(nested, 'file'), 'nested');
    execFileSync('git', ['-C', nested, 'commit', '-am', 'nested'], { stdio: 'pipe' });
    assert.match(worktreeRemovalRefusal('rm -rf .worktrees', f.repo, () => false)!, /nested/);
  } finally { f.cleanup(); }
});

test('a worktree Git cannot inspect is refused, not waved through', () => {
  const root = mkdtempSync(join(tmpdir(), 'worktree-guard-broken-'));
  try {
    const tree = join(root, 'orphan');
    mkdirSync(tree);
    writeFileSync(join(tree, '.git'), `gitdir: ${join(root, 'missing', '.git', 'worktrees', 'orphan')}\n`);
    assert.match(worktreeRemovalRefusal(`rm -rf "${tree}"`, root, () => false)!, /merge state is unknown/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
