import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardRefusal } from '../src/discard-guard.ts';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'discard-guard-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'file'), 'one'); git('add', 'file'); git('commit', '-m', 'initial');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  return { dir, git, dirty: () => writeFileSync(join(dir, 'file'), 'changed'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const command of ['git reset --hard', 'git checkout -- file', 'git checkout .', 'git restore file', 'git clean -fd', 'git stash drop', 'git stash clear']) {
  test(`dirty tracked files block ${command}`, async () => {
    const f = fixture(); try {
      f.dirty();
      assert.match(await discardRefusal(command, f.dir) ?? '', /alterações/i, command);
    } finally { f.cleanup(); }
  });
}

test('unpushed commits block hard reset but not when target or origin contains HEAD', async () => {
  const f = fixture(); try {
    f.dirty(); f.git('add', 'file'); f.git('commit', '-m', 'local');
    assert.match(await discardRefusal('git reset --hard HEAD~1', f.dir) ?? '', /commit/i);
    assert.equal(await discardRefusal('git reset --hard HEAD', f.dir), undefined);
    f.git('update-ref', 'refs/remotes/origin/other', f.git('rev-parse', 'HEAD'));
    assert.equal(await discardRefusal('git reset --hard HEAD~1', f.dir), undefined);
  } finally { f.cleanup(); }
});

test('clean tree allows destructive commands and stash-first protects edits', async () => {
  const f = fixture(); try {
    assert.equal(await discardRefusal('git reset --hard', f.dir), undefined);
    assert.equal(await discardRefusal('git checkout -- file', f.dir), undefined);
    f.dirty();
    assert.equal(await discardRefusal('git stash && git reset --hard', f.dir), undefined);
    assert.equal(await discardRefusal('git diff HEAD > saved.patch && git reset --hard', f.dir), undefined);
    assert.match(await discardRefusal('git diff HEAD > file && git reset --hard', f.dir) ?? '', /alterações/i);
    assert.match(await discardRefusal('git diff HEAD > saved.patch && git clean -fd', f.dir) ?? '', /alterações/i);
    assert.match(await discardRefusal('git stash; git reset --hard', f.dir) ?? '', /alterações/i);
    assert.match(await discardRefusal('git stash && git stash drop', f.dir) ?? '', /alterações/i);
    assert.match(await discardRefusal('git stash push -- file && git reset --hard', f.dir) ?? '', /alterações/i);
    assert.match(await discardRefusal(`git -C "${f.dir}" checkout -- file`, tmpdir()) ?? '', /alterações/i);
    assert.equal(await discardRefusal('git restore --staged file', f.dir), undefined);
  } finally { f.cleanup(); }
});

test('bash hook refuses dirty resets even when approvals are disabled', async () => {
  const f = fixture(); try {
    f.dirty();
    const hooks = new Map<string, (...args: any[]) => any>();
    registerEffectApprovals({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI, { enabled: false });
    const result = await hooks.get('tool_call')!({ toolName: 'bash', input: { command: 'git reset --hard' } }, { cwd: f.dir });
    assert.equal(result.block, true);
    assert.match(result.reason, /alterações/i);
  } finally { f.cleanup(); }
});
