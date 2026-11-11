import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tempDir } from './support.ts';

// scripts/worktree.mjs --done and --update on throwaway repos: a bare origin, the main checkout, a second clone that plays "the rest of the team", and a gh stub.
const SCRIPT = fileURLToPath(new URL('../scripts/worktree.mjs', import.meta.url));
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };
const GH_STUB = `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
appendFileSync(process.env.STUB_GH_LOG, process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(existsSync(process.env.STUB_GH_JSON) ? readFileSync(process.env.STUB_GH_JSON, 'utf8') : '[]');
`;

// Git joins conflicts closer than a few lines into one hunk; the spacer keeps the import hunk and the code hunk apart.
const SPACER = ['one', 'two', 'three', 'four', 'five', 'six'].map((w) => `// ${w}\n`).join('');

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (cwd: string, file: string, text: string) => writeFileSync(join(cwd, file), text);
function commit(cwd: string, file: string, text: string, message: string) {
  write(cwd, file, text);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function fixture() {
  const { dir, close } = tempDir('worktree-flow-');
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const other = join(dir, 'other');
  git(dir, ['init', '--bare', '-b', 'main', origin]);
  git(dir, ['clone', origin, work]);
  commit(work, 'a.ts', "import fs from 'node:fs';\n\nexport const x = 1;\n", 'first');
  git(work, ['push', 'origin', 'HEAD:main']);
  git(work, ['remote', 'set-head', 'origin', 'main']);
  git(dir, ['clone', origin, other]);
  const ghJson = join(dir, 'prs.json');
  const ghLog = join(dir, 'gh.log');
  writeFileSync(join(dir, 'gh-stub.mjs'), GH_STUB);
  const env = { ...process.env, ...ID, WORKTREE_GH: JSON.stringify([process.execPath, join(dir, 'gh-stub.mjs')]), STUB_GH_JSON: ghJson, STUB_GH_LOG: ghLog };
  const run = (args: string[], cwd = work) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env }); return { code: r.status, out: r.stdout }; };
  const wtPath = (name: string) => join(work, '.worktrees', name);
  /** A commit by someone else lands on origin/main. */
  const advanceMain = (file: string, text: string, message = `main: ${file}`) => { git(other, ['pull', '-q', '--ff-only', 'origin', 'main']); const sha = commit(other, file, text, message); git(other, ['push', '-q', 'origin', 'HEAD:main']); return sha; };
  /** The squash merge GitHub does: one commit with the branch's net change. */
  const squashMerge = (branch: string, message: string) => { git(other, ['pull', '-q', '--ff-only', 'origin', 'main']); git(other, ['fetch', '-q', 'origin']); git(other, ['merge', '--squash', `origin/${branch}`]); git(other, ['commit', '-m', message]); git(other, ['push', '-q', 'origin', 'HEAD:main']); return git(other, ['rev-parse', 'HEAD']); };
  const setPrs = (prs: unknown) => writeFileSync(ghJson, JSON.stringify(prs));
  const ghCalls = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n') : []);
  /** A worktree on branch `branch` with `commits` commits, each adding its own file (two or more keep a squash from being patch-identical to one of them, so only the PR proves the merge). */
  const task = (name: string, branch: string, commits = 1) => {
    assert.equal(run([name, '--branch', branch]).code, 0);
    let tip = '';
    for (let i = 1; i <= commits; i++) tip = commit(wtPath(name), `${name}-${i}.txt`, `feature ${i}\n`, `work ${i} on ${branch}`);
    return { path: wtPath(name), tip };
  };
  return { dir, work, other, run, wtPath, advanceMain, squashMerge, setPrs, ghCalls, task, close };
}

// ---------------------------------------------------------------- --done

test('--done after a SQUASH merge: worktree gone, branch deleted on the proof of the merged PR, main fast-forwarded, one block', () => {
  const f = fixture(); try {
  const { path, tip } = f.task('sq', 'feat/sq', 2);
  git(path, ['push', '-q', 'origin', 'feat/sq']);
  const merge = f.squashMerge('feat/sq', 'feat: sq (#7)');
  f.setPrs([{ number: 7, headRefOid: tip, mergeCommit: { oid: merge } }]);
  const mainBefore = git(f.work, ['rev-parse', 'HEAD']);
  const r = f.run(['--done', 'sq']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^status: done$/m);
  assert.match(r.out, /^worktree: removed$/m);
  assert.match(r.out, /^branch: deleted feat\/sq \(squash: head da PR == ponta local\)$/m, r.out);
  assert.match(r.out, new RegExp(`^pr: #7 mergeCommit ${merge.slice(0, 7)}$`, 'm'), r.out);
  assert.match(r.out, new RegExp(`^main: fast-forwarded ${mainBefore.slice(0, 7)}\\.\\.${merge.slice(0, 7)}$`, 'm'), r.out);
  assert.match(r.out, /^head: [0-9a-f]{7} feat: sq \(#7\)$/m, r.out);
  assert.ok(!existsSync(path));
  assert.equal(git(f.work, ['branch', '--list', 'feat/sq']), '', 'the squash-merged branch is deleted though git does not call it merged');
  assert.equal(git(f.work, ['rev-parse', 'HEAD']), merge, 'main checkout fast-forwarded');
  assert.ok(f.ghCalls().some((c) => /pr list --head feat\/sq --state merged --json number,headRefOid,mergeCommit/.test(c)), f.ghCalls().join('|'));
} finally { f.close(); } });

test('--done also proves a squash merge by tree when the local tip was amended after the PR head was recorded', () => {
  const f = fixture(); try {
  const { path, tip } = f.task('amend', 'feat/amend', 2);
  git(path, ['push', '-q', 'origin', 'feat/amend']);
  const merge = f.squashMerge('feat/amend', 'feat: amend (#8)');
  git(path, ['commit', '--amend', '-q', '-m', 'reworded after the push']);
  assert.notEqual(git(path, ['rev-parse', 'HEAD']), tip);
  f.setPrs([{ number: 8, headRefOid: tip, mergeCommit: { oid: merge } }]);
  const r = f.run(['--done', 'amend']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^branch: deleted feat\/amend \(squash: árvore da PR == árvore local\)$/m, r.out);
  assert.equal(git(f.work, ['branch', '--list', 'feat/amend']), '');
} finally { f.close(); } });

test('--done keeps an unmerged branch and says why: no merged PR, or commits made after the merged PR head', () => {
  const f = fixture(); try {
  const a = f.task('open', 'feat/open');
  f.setPrs([]);
  const none = f.run(['--done', 'open']);
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /^branch: kept feat\/open$/m, none.out);
  assert.match(none.out, /^reason: nenhuma PR mesclada para feat\/open$/m, none.out);
  assert.ok(!existsSync(a.path), 'the worktree is still removed');
  assert.equal(git(f.work, ['rev-parse', 'refs/heads/feat/open']), a.tip, 'the branch and its commit survive');

  const b = f.task('later', 'feat/later', 2);
  git(b.path, ['push', '-q', 'origin', 'feat/later']);
  const merge = f.squashMerge('feat/later', 'feat: later (#9)');
  commit(b.path, 'more.txt', 'after the merge\n', 'work after the merge');
  f.setPrs([{ number: 9, headRefOid: b.tip, mergeCommit: { oid: merge } }]);
  const later = f.run(['--done', 'later']);
  assert.match(later.out, /^branch: kept feat\/later$/m, later.out);
  assert.match(later.out, /^reason: a ponta local [0-9a-f]{7} difere da PR #9 mesclada/m, later.out);
  assert.equal(git(f.work, ['branch', '--list', 'feat/later']).includes('feat/later'), true);
} finally { f.close(); } });

test('--done deletes a branch git itself sees as merged without asking gh, and refuses a dirty worktree without removing anything', () => {
  const f = fixture(); try {
  const plain = f.task('plain', 'feat/plain');
  git(plain.path, ['push', '-q', 'origin', 'feat/plain']);
  git(f.other, ['pull', '-q', '--ff-only', 'origin', 'main']);
  git(f.other, ['fetch', '-q', 'origin']);
  git(f.other, ['merge', '--ff-only', 'origin/feat/plain']);
  git(f.other, ['push', '-q', 'origin', 'HEAD:main']);
  const ok = f.run(['--done', 'plain']);
  assert.match(ok.out, /^branch: deleted feat\/plain \(ancestral de origin\/main\)$/m, ok.out);
  assert.deepEqual(f.ghCalls(), [], 'no gh call when git already proves it');

  const dirty = f.task('dirty', 'feat/dirty');
  write(dirty.path, 'a.ts', 'changed\n');
  const refused = f.run(['--done', 'dirty']);
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /^error: dirty$/m);
  assert.ok(existsSync(join(dirty.path, 'a.ts')), 'the dirty worktree is untouched');
  assert.match(f.run(['--done', 'nope']).out, /error: not_found/);
} finally { f.close(); } });

test('--done and --update accept the branch name of a worktree and resolve it to its folder; an unknown branch still refuses bad_name', () => {
  const f = fixture(); try {
  const { path, tip } = f.task('bybranch', 'feat/by-branch');
  git(path, ['push', '-q', 'origin', 'feat/by-branch']);
  git(f.other, ['pull', '-q', '--ff-only', 'origin', 'main']);
  git(f.other, ['fetch', '-q', 'origin']);
  git(f.other, ['merge', '--ff-only', 'origin/feat/by-branch']);
  git(f.other, ['push', '-q', 'origin', 'HEAD:main']);
  const upd = f.run(['--update', 'feat/by-branch']);
  assert.doesNotMatch(upd.out, /error: bad_name/, upd.out);
  assert.equal(git(path, ['rev-parse', 'HEAD']), tip, 'the branch was resolved to its worktree, not refused');
  const done = f.run(['--done', 'feat/by-branch']);
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /^status: done$/m, done.out);
  assert.match(done.out, /^branch: deleted feat\/by-branch/m, done.out);
  assert.ok(!existsSync(path), 'the worktree of the branch is removed');
  const unknown = f.run(['--done', 'feat/nope']);
  assert.equal(unknown.code, 2, unknown.out);
  assert.match(unknown.out, /error: bad_name/);
} finally { f.close(); } });

test('--done leaves the main checkout alone when its fast-forward is impossible, and says so', () => {
  const f = fixture(); try {
  f.task('x', 'feat/x');
  commit(f.work, 'local.txt', 'local only\n', 'local commit on main');
  f.advanceMain('other.txt', 'o\n');
  const r = f.run(['--done', 'x']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^main: skipped: /m, r.out);
} finally { f.close(); } });

// ---------------------------------------------------------------- --update

test('--update rebases a branch that was never pushed and reports head, ahead/behind, diffstat and that there is nothing to push', () => {
  const f = fixture(); try {
  const { path } = f.task('rb', 'feat/rb');
  const upstream = f.advanceMain('b.txt', 'b\n');
  const r = f.run(['--update', 'rb']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^status: updated$/m, r.out);
  assert.match(r.out, /^mode: rebase$/m);
  assert.match(r.out, /^ahead_behind: 1\/0 vs origin\/main$/m, r.out);
  assert.match(r.out, /^diffstat: 1 file changed, 1 insertion\(\+\)$/m, r.out);
  assert.match(r.out, /^push: n\/a/m, r.out);
  assert.equal(git(path, ['rev-parse', 'HEAD~1']), upstream, 'the branch commit sits on top of origin/main');
  assert.equal(git(path, ['status', '--porcelain']), '');
  assert.match(f.run(['--update', 'rb']).out, /^status: up_to_date$/m, 'a second run changes nothing');
} finally { f.close(); } });

test('--update merges origin/main into a pushed branch (no rewrite, no force-push) and says the push is needed', () => {
  const f = fixture(); try {
  const { path, tip } = f.task('mg', 'feat/mg');
  git(path, ['push', '-q', 'origin', 'feat/mg']);
  f.advanceMain('b.txt', 'b\n');
  const r = f.run(['--update', 'mg']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^mode: merge$/m, r.out);
  assert.match(r.out, /^push: needed$/m, r.out);
  assert.equal(git(path, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3, 'a merge commit with two parents');
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', 'origin/feat/mg', 'HEAD'], { cwd: path }).status, 0, 'the pushed history is an ancestor: a plain push is enough');
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', tip, 'HEAD'], { cwd: path }).status, 0);
} finally { f.close(); } });

test('--update resolves a conflict where both sides only added import lines (union, deduped, ours first), for rebase and merge', () => {
  for (const [name, pushed] of [['imp-rb', false], ['imp-mg', true]] as const) {
    const f = fixture(); try {
    const branch = `feat/${name}`;
    f.run([name, '--branch', branch]);
    const path = f.wtPath(name);
    commit(path, 'a.ts', "import fs from 'node:fs';\nimport os from 'node:os';\nimport url from 'node:url';\n\nexport const x = 1;\n", `${name}: branch imports`);
    if (pushed) git(path, ['push', '-q', 'origin', branch]);
    f.advanceMain('a.ts', "import fs from 'node:fs';\nimport path from 'node:path';\nimport url from 'node:url';\n\nexport const x = 1;\n", `${name}: main imports`);
    // "ours first" as git means it: origin/main in a rebase, the branch in a merge.
    const mainLine = "import path from 'node:path';"; const branchLine = "import os from 'node:os';";
    const ours = pushed ? `${branchLine}\n${mainLine}` : `${mainLine}\n${branchLine}`;
    const r = f.run(['--update', name]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^status: updated$/m, r.out);
    assert.match(r.out, /^resolved: import-only: a\.ts \(1\)$/m, r.out);
    assert.equal(readFileSync(join(path, 'a.ts'), 'utf8').replace(/\r\n/g, '\n'), `import fs from 'node:fs';\n${ours}\nimport url from 'node:url';\n\nexport const x = 1;\n`);
    assert.equal(git(path, ['status', '--porcelain']), '');
    } finally { f.close(); }
  }
});

test('--update never resolves a hunk that is not import-only: it stays mid-operation with a compact list and the exact next commands', () => {
  const f = fixture(); try {
  f.run(['nc', '--branch', 'feat/nc']);
  const path = f.wtPath('nc');
  commit(path, 'a.ts', "import fs from 'node:fs';\n\nexport const x = 3;\n", 'branch: x=3');
  f.advanceMain('a.ts', "import fs from 'node:fs';\n\nexport const x = 2;\n", 'main: x=2');
  const r = f.run(['--update', 'nc']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /^status: conflict$/m, r.out);
  assert.match(r.out, /^conflict: a\.ts:3 \| ours: export const x = 2; \| theirs: export const x = 3; \| hunks: 1$/m, r.out);
  assert.match(r.out, /^next: .*--update nc.*desistir: git -C \S+\.worktrees\/nc rebase --abort$/m, r.out);
  assert.ok(existsSync(join(path, '.git')) && /<<<<<<< /.test(readFileSync(join(path, 'a.ts'), 'utf8')), 'markers left in the file');
  assert.equal(spawnSync('git', ['rebase', '--show-current-patch'], { cwd: path }).status, 0, 'the rebase is still in progress');

  write(path, 'a.ts', "import fs from 'node:fs';\n\nexport const x = 23;\n");
  const resumed = f.run(['--update', 'nc']);
  assert.equal(resumed.code, 0, resumed.out);
  assert.match(resumed.out, /^status: updated$/m, resumed.out);
  assert.equal(git(path, ['status', '--porcelain']), '');
  assert.equal(git(path, ['branch', '--show-current']), 'feat/nc');
} finally { f.close(); } });

test('--update does not union two different edits of one import (the same module on both sides) and resolves only the import hunks of a mixed file', () => {
  const f = fixture(); try {
  f.run(['same', '--branch', 'feat/same']);
  const path = f.wtPath('same');
  commit(path, 'a.ts', "import fs, { a } from 'node:fs';\n\nexport const x = 1;\n", 'branch edits the fs import');
  f.advanceMain('a.ts', "import fs, { b } from 'node:fs';\n\nexport const x = 1;\n", 'main edits the fs import');
  const same = f.run(['--update', 'same']);
  assert.equal(same.code, 3, same.out);
  assert.match(same.out, /^conflict: a\.ts:1 \|/m, same.out);
  git(path, ['rebase', '--abort']);

  f.advanceMain('a.ts', `import fs from 'node:fs';\n\n${SPACER}export const x = 1;\n`, 'main: spacing between the imports and the code');
  const g = f.run(['mixed', '--branch', 'feat/mixed']);
  assert.equal(g.code, 0, g.out);
  const mixed = f.wtPath('mixed');
  commit(mixed, 'a.ts', `import fs from 'node:fs';\nimport os from 'node:os';\n\n${SPACER}export const x = 3;\n`, 'branch: os import and x=3');
  git(f.other, ['pull', '-q', '--ff-only', 'origin', 'main']);
  commit(f.other, 'a.ts', `import fs from 'node:fs';\nimport path from 'node:path';\n\n${SPACER}export const x = 2;\n`, 'main: path import and x=2');
  git(f.other, ['push', '-q', 'origin', 'HEAD:main']);
  const r = f.run(['--update', 'mixed']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /^resolved: import-only: a\.ts \(1\)$/m, r.out);
  assert.match(r.out, /^conflict: a\.ts:\d+ \| ours: export const x = 2; \| theirs: export const x = 3; \| hunks: 1$/m, r.out);
  const text = readFileSync(join(mixed, 'a.ts'), 'utf8');
  assert.match(text.replace(/\r\n/g, '\n'), /import path from 'node:path';\nimport os from 'node:os';\n/);
  assert.match(text, /<<<<<<< /);
} finally { f.close(); } });

test('--update --check runs the command after a clean update and reports its rc; a failing check exits 3 with its output tail', () => {
  const f = fixture(); try {
  f.task('chk', 'feat/chk');
  f.advanceMain('b.txt', 'b\n');
  const ok = f.run(['--update', 'chk', '--check', 'node -e "console.log(process.cwd().length > 0)"']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /^check: rc=0: node -e /m, ok.out);

  const bad = f.run(['--update', 'chk', '--check', 'node -e "console.error(\'boom\'); process.exit(3)"']);
  assert.equal(bad.code, 3, bad.out);
  assert.match(bad.out, /^status: check_failed$/m, bad.out);
  assert.match(bad.out, /^check: rc=3: /m, bad.out);
  assert.match(bad.out, /^check_out: boom$/m, bad.out);
} finally { f.close(); } });

test('--update refuses a dirty worktree, an unknown name and a wrong flag without touching anything', () => {
  const f = fixture(); try {
  const { path, tip } = f.task('d', 'feat/d');
  f.advanceMain('b.txt', 'b\n');
  write(path, 'd-1.txt', 'edited\n');
  const dirty = f.run(['--update', 'd']);
  assert.equal(dirty.code, 2, dirty.out);
  assert.match(dirty.out, /^error: dirty$/m);
  assert.equal(git(path, ['rev-parse', 'HEAD']), tip);
  assert.match(f.run(['--update', 'nope']).out, /error: not_found/);
  assert.match(f.run(['--done', 'd', '--check', 'x']).out, /error: bad_args/);
  assert.match(f.run(['--update', 'd', '--check']).out, /error: bad_args/);
} finally { f.close(); } });

test('a whole PR lifecycle takes two calls: --update before the push, --done after the squash merge', () => {
  const f = fixture(); try {
  const { path, tip } = f.task('life', 'feat/life', 2);
  f.advanceMain('b.txt', 'b\n');
  assert.equal(f.run(['--update', 'life']).code, 0);                      // call 1: was fetch + rebase + (resolver) + tsc + continue
  const pushedTip = git(path, ['rev-parse', 'HEAD']);
  assert.notEqual(pushedTip, tip);
  git(path, ['push', '-q', 'origin', 'feat/life']);
  const merge = f.squashMerge('feat/life', 'feat: life (#10)');
  f.setPrs([{ number: 10, headRefOid: pushedTip, mergeCommit: { oid: merge } }]);
  const done = f.run(['--done', 'life']);                                  // call 2: was worktree remove + branch -D + pull --ff-only
  assert.equal(done.code, 0, done.out);
  assert.equal(git(f.work, ['branch', '--list', 'feat/life']), '');
  assert.equal(git(f.work, ['rev-parse', 'HEAD']), merge);
  assert.ok(!existsSync(path));
} finally { f.close(); } });
