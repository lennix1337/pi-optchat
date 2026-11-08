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

test('advisor cannot override an unmerged worktree refusal', async () => {
  const f = fixture();
  try {
    const hooks = new Map<string, (...args: any[]) => any>();
    let advised = false;
    registerEffectApprovals({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI,
      { enabled: true, advisor: async () => { advised = true; return { approve: true, model: 'test', reason: 'yes' }; } });
    const result = await hooks.get('tool_call')!({ toolName: 'bash', input: { command: `git -C "${f.repo}" worktree remove -f "${f.tree}"` } }, { cwd: f.repo });
    assert.match(result.reason, /feature.*explicit order/i);
    assert.equal(advised, false);
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
