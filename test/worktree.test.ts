import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tempDir } from './support.ts';

// scripts/worktree.mjs through its command line, on a temp clone of a bare origin.
const SCRIPT = fileURLToPath(new URL('../scripts/worktree.mjs', import.meta.url));
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function fixture(withModules = true) {
  const { dir, close } = tempDir('worktree-');
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  git(dir, ['init', '--bare', '-b', 'main', origin]);
  git(dir, ['clone', origin, work]);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'first']);
  git(work, ['push', 'origin', 'HEAD:main']);
  git(work, ['remote', 'set-head', 'origin', 'main']);
  if (withModules) { mkdirSync(join(work, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(join(work, 'node_modules', 'pkg', 'i.js'), '1'); }
  return { work, close, run: (args: string[], cwd = work) => { const r = spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' }); return { code: r.status, out: r.stdout }; } };
}

test('creates .worktrees/<name> from origin/main with a node_modules junction, in one command', () => {
  const f = fixture(); try {
  const r = f.run(['task-a']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /status: created/);
  const wt = join(f.work, '.worktrees', 'task-a');
  assert.ok(existsSync(join(wt, 'a.txt')));
  assert.ok(existsSync(join(wt, 'node_modules', 'pkg', 'i.js')), 'dependencies reachable through the junction');
  assert.equal(git(wt, ['branch', '--show-current']), 'wt/task-a');
  assert.equal(realpathSync(join(wt, 'node_modules')), realpathSync(join(f.work, 'node_modules')));
} finally { f.close(); } });

test('runs from inside a linked worktree and still lands in the main checkout; honors --branch', () => {
  const f = fixture(); try {
  assert.equal(f.run(['one']).code, 0);
  const r = f.run(['two', '--branch', 'fix/two'], join(f.work, '.worktrees', 'one'));
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(f.work, '.worktrees', 'two', 'a.txt')));
  assert.equal(git(join(f.work, '.worktrees', 'two'), ['branch', '--show-current']), 'fix/two');
} finally { f.close(); } });

test('refuses an existing folder, an existing branch and an unsafe name without side effects', () => {
  const f = fixture(false); try {
  assert.equal(f.run(['x']).code, 0);
  assert.match(f.run(['x']).out, /error: exists/);
  const taken = f.run(['y', '--branch', 'wt/x']);
  assert.equal(taken.code, 2);
  assert.match(taken.out, /error: branch_exists/);
  assert.ok(!existsSync(join(f.work, '.worktrees', 'y')));
  assert.match(f.run(['../evil']).out, /error: bad_name/);
  assert.match(f.run([]).out, /error: bad_name/);
} finally { f.close(); } });

test('a checkout without node_modules still gets a worktree and says so', () => {
  const f = fixture(false); try {
  const r = f.run(['bare']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /node_modules: absent/);
} finally { f.close(); } });
