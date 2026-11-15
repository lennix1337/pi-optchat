import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import { registerCommitHookGuard } from '../src/commit-hook-guard.ts';
import { classifyEffects, classifyEffectsAsync, type AsyncRepo, type Repo } from '../src/autonomy.ts';
import { branchMerged } from '../src/merged-branch.ts';
import { removeDir } from './support.ts';

test('awaited repository answers preserve synchronous classification, including nested scripts and cleanup', async () => {
  const repo: Repo = {
    slug: () => 'example/repo', branch: () => 'main',
    merged: (_path, branch) => branch === 'landed',
    worktree: () => ({ branch: 'landed', clean: true }),
    script: () => "import OpenAI from 'openai';",
  };
  const asyncRepo: AsyncRepo = {
    slug: async (...args) => repo.slug(...args), branch: async path => repo.branch(path),
    merged: async (path, branch) => repo.merged!(path, branch),
    worktree: async path => repo.worktree!(path), script: async path => repo.script!(path),
  };
  for (const command of ['git push', 'git push origin HEAD', 'git push --force', 'git branch -D landed',
    'git branch -D landed open', 'git worktree remove --force ../landed', 'git reset --hard',
    'gh pr merge 1', 'gh release create v1', 'gh workflow run deploy.yml', 'npm publish', 'vercel --prod',
    'node deploy.mjs', 'bash -c "git push && npm publish"', 'node provider.mjs', 'npx tsx provider.ts']) {
    const call = { tool: 'bash', input: { command }, cwd: '/repo' };
    assert.deepEqual(await classifyEffectsAsync(call, asyncRepo), classifyEffects(call, repo), command);
  }
  for (const failure of [
    { merged: async () => { throw new Error('gh unavailable'); } },
    { worktree: async () => { throw new Error('git unavailable'); } },
  ]) {
    const effects = await classifyEffectsAsync({ tool: 'bash', input: { command: 'git worktree remove --force ../landed' }, cwd: '/repo' }, { ...asyncRepo, ...failure });
    assert.deepEqual(effects, [{ action: 'discard', targets: ['/repo'] }], 'unknown state never frees a destructive cleanup');
  }
});

test('merged lookup awaits GitHub and still fails closed on an asynchronous failure', async () => {
  let queried = false;
  const merged = await branchMerged('/repo', 'feature', async (command, args) => {
    if (command === 'gh') { queried = true; throw new Error('timeout'); }
    if (args[0] === 'merge-base') throw new Error('not ancestor');
    return args[0] === 'symbolic-ref' ? 'origin/main' : 'a'.repeat(40);
  });
  assert.equal(queried, true);
  assert.equal(merged, false);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bash-hooks-'));
  const git = (...args: string[]) => childProcess.execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('branch', 'landed');
  mkdirSync(join(dir, '.husky'));
  writeFileSync(join(dir, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(dir, 'autonomy.json'), JSON.stringify({ version: 1, default: 'report', rules: [
    { action: 'push-main', scope: ['example/repo'], level: 'ask' },
    { action: 'discard', scope: ['merged-branch'], level: 'free' },
    { action: 'discard', scope: ['*'], level: 'ask' },
  ] }));
  return dir;
}

function harness(dir: string) {
  const hooks = new Map<string, Function>();
  const pi = { on: (name: string, fn: Function) => hooks.set(name, fn), getActiveTools: () => ['bash', 'shell_start'] } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => 'async-hooks' }, ui: { notify() {}, setWidget() {} } };
  const call = (command: string) => hooks.get('tool_call')!({ toolName: 'bash', toolCallId: 'c', input: { command, timeout: 60 } }, ctx);
  return { pi, call };
}

test('bash approval resolves remote, branch and merged state without synchronous child processes', async t => {
  const dir = fixture();
  try {
    const h = harness(dir);
    registerEffectApprovals(h.pi, { enabled: true, mode: 'risk', bell() {}, contractDir: () => dir });
    const sync = t.mock.method(childProcess, 'execFileSync');
    syncBuiltinESMExports();
    try {
      const blocked = await h.call('git push');
      assert.equal(blocked?.block, true, 'main push still needs approval for its resolved slug');
      const allowed = await h.call('git branch -D landed');
      assert.equal(allowed, undefined, 'a locally merged branch remains free');
      assert.equal(sync.mock.callCount(), 0, 'tool_call must await git/gh rather than block Pi');
    } finally { sync.mock.restore(); syncBuiltinESMExports(); }
  } finally { removeDir(dir); }
});

test('bash commit guard finds the hook without synchronous child processes', async t => {
  const dir = fixture();
  try {
    const h = harness(dir);
    registerCommitHookGuard(h.pi);
    const sync = t.mock.method(childProcess, 'execFileSync');
    syncBuiltinESMExports();
    try {
      const blocked = await h.call('git commit -m x');
      assert.equal(blocked?.block, true);
      assert.match(blocked.reason, /pre-commit/);
      assert.equal(sync.mock.callCount(), 0, 'commit preflight must not block Pi');
    } finally { sync.mock.restore(); syncBuiltinESMExports(); }
  } finally { removeDir(dir); }
});
