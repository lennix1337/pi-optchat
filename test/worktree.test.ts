import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('--remove takes the worktree and its node_modules junction away, leaves the main node_modules intact and keeps the branch when unmerged', () => {
  const f = fixture(); try {
  assert.equal(f.run(['gone']).code, 0);
  const wt = join(f.work, '.worktrees', 'gone');
  writeFileSync(join(wt, 'new.txt'), 'n\n'); git(wt, ['add', 'new.txt']); git(wt, ['commit', '-m', 'unmerged work']);
  const r = f.run(['--remove', 'gone']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /status: removed/);
  assert.ok(!existsSync(wt), 'no leftover folder');
  assert.ok(existsSync(join(f.work, 'node_modules', 'pkg', 'i.js')), 'main node_modules untouched');
  assert.match(r.out, /branch: kept/);
  assert.equal(git(f.work, ['branch', '--list', 'wt/gone']).includes('wt/gone'), true);
} finally { f.close(); } });

test('--remove deletes a merged branch and refuses a dirty worktree, restoring its junction', () => {
  const f = fixture(); try {
  assert.equal(f.run(['clean']).code, 0);
  const merged = f.run(['--remove', 'clean']);
  assert.match(merged.out, /branch: deleted/);
  assert.equal(git(f.work, ['branch', '--list', 'wt/clean']), '');
  assert.equal(f.run(['dirty']).code, 0);
  const wt = join(f.work, '.worktrees', 'dirty');
  writeFileSync(join(wt, 'a.txt'), 'changed\n');
  const r = f.run(['--remove', 'dirty']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /error: dirty/);
  assert.ok(existsSync(join(wt, 'node_modules', 'pkg', 'i.js')), 'junction restored after the refusal');
  assert.match(f.run(['--remove', 'nope']).out, /error: not_found/);
} finally { f.close(); } });

test('the next-step hint names the ship.mjs next to this script, also for a repository that has none', () => {
  const f = fixture(); try {
  const r = f.run(['task-hint']);
  assert.equal(r.code, 0, r.out);
  const flat = (text: string) => text.replace(/[\\/]+/g, '/');
  const hint = flat(r.out.split('\n').find((l) => l.startsWith('next:')) ?? '');
  assert.ok(hint.includes(flat(fileURLToPath(new URL('../scripts/ship.mjs', import.meta.url)))), hint);
} finally { f.close(); } });

test('--list classifies each worktree in one call: removable, dirty, unmerged', () => {
  const f = fixture(false); try {
  for (const n of ['clean', 'dirty', 'ahead']) assert.equal(f.run([n]).code, 0);
  writeFileSync(join(f.work, '.worktrees', 'dirty', 'a.txt'), 'changed\n');
  const ahead = join(f.work, '.worktrees', 'ahead');
  writeFileSync(join(ahead, 'b.txt'), 'b\n');
  git(ahead, ['add', '.']);
  git(ahead, ['commit', '-m', 'unique work']);
  const r = f.run(['--list']);
  assert.equal(r.code, 0, r.out);
  const rows = Object.fromEntries(r.out.split('\n').filter((l) => l.includes('|')).map((l) => { const c = l.split('|').map((s) => s.trim()); return [c[0], c.slice(1)]; }));
  assert.deepEqual(rows.clean, ['wt/clean', 'dirty=0', 'unique=0', 'removable']);
  assert.deepEqual(rows.dirty, ['wt/dirty', 'dirty=1', 'unique=0', 'keep: dirty']);
  assert.deepEqual(rows.ahead, ['wt/ahead', 'dirty=0', 'unique=1', 'keep: unmerged']);
  assert.match(r.out, /status: listed/);
} finally { f.close(); } });

test('--list also finds worktrees when the repo is reached through a link (Windows short or junction paths)', () => {
  const f = fixture(false); try {
  assert.equal(f.run(['viaLink']).code, 0);
  const link = join(f.work, '..', 'work-link');
  symlinkSync(f.work, link, 'junction');
  const r = f.run(['--list'], link);
  assert.match(r.out, /viaLink \| wt\/viaLink \| dirty=0 \| unique=0 \| removable/, r.out);
} finally { f.close(); } });
