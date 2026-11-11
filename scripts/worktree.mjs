#!/usr/bin/env node
// Creates a task worktree in one command: fetch, `.worktrees/<name>` on a new branch from origin/<base>, and a
// node_modules junction to the main checkout, so the first test run needs no manual setup.
// Usage: node scripts/worktree.mjs <name> [--branch NOME] [--base BRANCH]
//        node scripts/worktree.mjs --remove <name>   (drops the junction first, refuses a dirty worktree, deletes the branch only if merged)
//        node scripts/worktree.mjs --list   (one row per worktree: name | branch | dirty | unique commits vs origin/<base> | removable or keep: reason)
//        node scripts/worktree.mjs --done <name|branch> [--base BRANCH]   (after the PR merged: removes the worktree, deletes the local branch also when GitHub SQUASH-merged it,
//            proved by a merged PR whose head is the local tip or has its tree; otherwise keeps the branch and says why; then fast-forwards the main checkout's base branch)
//        node scripts/worktree.mjs --update <name|branch> [--check "<cmd>"] [--base BRANCH]   (brings the branch up to origin/<base>: rebase when not pushed, merge when pushed, never a force-push;
//            only conflict hunks where both sides are solely import/require lines are resolved (union); the rest stays mid-operation and is listed; rerun the same command after resolving to continue;
//            --check runs <cmd> in the worktree after a clean result and reports its rc; a pushed branch ends with `push: needed`, the push itself is yours)
// Test seam: WORKTREE_GH = JSON array with the gh command (default ["gh"]).
// Output is a flat key: value block ending in `rc:`; exit 0 ok, 2 refused, 3 failed (also an unresolved conflict or a failing --check).
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = (status, fields, code) => {
  const lines = Object.entries({ status, ...fields }).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${JSON.stringify(v).replace(/^"|"$/g, '')}`);
  process.stdout.write(`${lines.join('\n')}\nrc: ${code}\n`);
  return code;
};
const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'merge.conflictStyle=merge', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' } });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr || r.stdout || r.error?.message || '').trim() };
};
// Raw `key: value` lines for the git-flow verbs: paths and commands stay readable (no JSON escaping), and `rows` follow the fields.
const emit = (status, fields, code, rows = []) => {
  const lines = Object.entries({ status, ...fields }).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${String(v).replace(/\s*\r?\n\s*/g, ' ')}`);
  process.stdout.write(`${[...lines, ...rows].join('\n')}\nrc: ${code}\n`);
  return code;
};
const fwd = (p) => p.split('\\').join('/');
const short = (sha) => sha.slice(0, 7);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The folder name, under .worktrees/, of the one worktree checked out on `branch`; undefined when none or more than one matches. */
function folderOfBranch(main, branch) {
  const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  const root = real(join(main, '.worktrees'));
  const found = [];
  for (const block of git(main, ['worktree', 'list', '--porcelain']).out.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path || /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] !== branch) continue;
    const rel = relative(root, real(path)).split('\\').join('/');
    if (NAME.test(rel)) found.push(rel);
  }
  return found.length === 1 ? found[0] : undefined;
}

/** A worktree argument is its folder name, or the branch checked out in that folder (`feat/x` is no folder name). */
function worktreeName(arg, cwd) {
  if (NAME.test(arg)) return arg;
  const main = mainOf(cwd);
  return main ? folderOfBranch(main, arg) : undefined;
}

function mainOf(cwd) {
  const common = git(cwd, ['rev-parse', '--git-common-dir']);
  return common.ok ? resolve(cwd, common.out, '..') : '';
}

/** Takes a worktree away, its node_modules junction first (the link itself, never the main node_modules behind it); a refusal (dirty) restores the junction. */
function dropWorktree(main, path) {
  const link = join(path, 'node_modules');
  const linked = existsSync(link) && lstatSync(link).isSymbolicLink();
  if (linked) rmSync(link, { recursive: false, force: true });
  const removed = git(main, ['worktree', 'remove', path]);
  if (!removed.ok) {
    if (linked) symlinkSync(join(main, 'node_modules'), link, 'junction');
    return removed;
  }
  rmSync(path, { recursive: false, force: true });
  git(main, ['worktree', 'prune']);
  return removed;
}

function removeWorktree(name, cwd) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return out('refused', { error: 'bad_name', hint: 'uso: node scripts/worktree.mjs --remove <nome>' }, 2);
  const main = mainOf(cwd);
  if (!main) return out('refused', { error: 'not_a_repo' }, 2);
  const path = join(main, '.worktrees', name);
  if (!existsSync(path)) return out('refused', { error: 'not_found', path }, 2);
  const branch = git(path, ['branch', '--show-current']).out;
  const removed = dropWorktree(main, path);
  if (!removed.ok) return out('refused', { error: 'dirty', path, detail: removed.err.slice(0, 300), hint: 'commite ou descarte as alterações antes de remover' }, 2);
  const deleted = branch && git(main, ['branch', '-d', branch]).ok;
  return out('removed', { path, branch: !branch ? 'none' : deleted ? 'deleted' : 'kept', next: branch && !deleted ? `branch ${branch} tem commits não mesclados` : undefined }, 0);
}

function listWorktrees(cwd, all = false) {
  const main = mainOf(cwd);
  if (!main) return out('refused', { error: 'not_a_repo' }, 2);
  const base = git(main, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).out || 'origin/main';
  const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  const root = real(join(main, '.worktrees'));
  const lines = (text) => text.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const block of git(main, ['worktree', 'list', '--porcelain']).out.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    const name = path && relative(all ? real(main) : root, real(path)).split('\\').join('/');
    if (!name || (!all && (name.startsWith('..') || name.includes('/')))) continue;
    const dirty = lines(git(path, ['status', '--porcelain']).out).length;
    const unique = branch ? lines(git(main, ['cherry', base, branch]).out).filter((l) => l.startsWith('+')).length : 0;
    const verdict = !branch ? 'keep: detached' : dirty ? 'keep: dirty' : unique ? 'keep: unmerged' : 'removable';
    rows.push(`${name} | ${branch ?? '-'} | dirty=${dirty} | unique=${unique} | ${verdict}`);
  }
  process.stdout.write(`status: listed\ncount: ${rows.length}\n${rows.join('\n')}${rows.length ? '\n' : ''}rc: 0\n`);
  return 0;
}

// --- git flow: --done and --update ---------------------------------------------------------------------------------------------------
const lines = (text) => text.split(/\r?\n/).filter(Boolean);
const baseOf = (main, explicit) => explicit || git(main, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).out.replace(/^origin\//, '') || 'main';

function ghMergedPrs(main, branch) {
  let cmd = ['gh'];
  try { if (process.env.WORKTREE_GH) cmd = JSON.parse(process.env.WORKTREE_GH); } catch { return { error: 'WORKTREE_GH inválido' }; }
  const r = spawnSync(cmd[0], [...cmd.slice(1), 'pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,headRefOid,mergeCommit', '--limit', '10'], { cwd: main, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) return { error: `gh indisponível: ${(r.stderr || r.error?.message || `rc ${r.status}`).trim().split('\n')[0].slice(0, 160)}` };
  try { return { prs: JSON.parse(r.stdout || '[]') }; } catch { return { error: 'gh devolveu JSON inválido' }; }
}

/** Is the work of `tip` already in origin/<base>? Plain git first (ancestor, then every patch present), then GitHub for a squash merge: a merged PR whose head is the tip or has the tip's tree. */
function mergedProof(main, branch, tip, base) {
  const ref = `origin/${base}`;
  if (git(main, ['merge-base', '--is-ancestor', tip, ref]).ok) return { merged: true, how: `ancestral de ${ref}` };
  if (!lines(git(main, ['cherry', ref, tip]).out).some((l) => l.startsWith('+'))) return { merged: true, how: `patches já em ${ref}` };
  const gh = ghMergedPrs(main, branch);
  if (gh.error) return { merged: false, reason: `não está em ${ref} e ${gh.error}` };
  const tipTree = git(main, ['rev-parse', `${tip}^{tree}`]).out;
  for (const pr of gh.prs) if (pr.headRefOid === tip) return { merged: true, how: 'squash: head da PR == ponta local', pr };
  for (const pr of gh.prs) {
    const tree = git(main, ['rev-parse', '--verify', '--quiet', `${pr.headRefOid}^{tree}`]);
    if (tree.ok && tree.out === tipTree) return { merged: true, how: 'squash: árvore da PR == árvore local', pr };
  }
  const last = gh.prs[0];
  return { merged: false, reason: last ? `a ponta local ${short(tip)} difere da PR #${last.number} mesclada (head ${short(last.headRefOid)}): há trabalho depois do merge` : `nenhuma PR mesclada para ${branch}` };
}

/** Fast-forwards the local <base> from origin/<base>: with --ff-only in the main checkout when it sits on <base>, by moving the ref when it sits elsewhere and no worktree has <base> open. */
function fastForwardBase(main, base) {
  const ref = `origin/${base}`;
  const before = git(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]).out;
  const target = git(main, ['rev-parse', '--verify', '--quiet', ref]).out;
  if (!before || !target) return `skipped: sem ${before ? ref : `branch local ${base}`}`;
  if (before === target) return `up-to-date em ${short(target)}`;
  const current = git(main, ['branch', '--show-current']).out;
  if (current === base) {
    const merged = git(main, ['merge', '--ff-only', ref]);
    return merged.ok ? `fast-forwarded ${short(before)}..${short(target)}` : `skipped: ${merged.err.split('\n')[0].slice(0, 160)}`;
  }
  if (!git(main, ['merge-base', '--is-ancestor', before, target]).ok) return `skipped: ${base} local divergiu de ${ref}`;
  if (new RegExp(`^branch refs/heads/${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(git(main, ['worktree', 'list', '--porcelain']).out)) return `skipped: ${base} está aberta em outro worktree`;
  const moved = git(main, ['update-ref', `refs/heads/${base}`, target, before]);
  return moved.ok ? `fast-forwarded ${short(before)}..${short(target)} (checkout principal está em ${current || 'HEAD solto'})` : `skipped: ${moved.err.split('\n')[0].slice(0, 160)}`;
}

function doneWorktree(arg, cwd, baseOpt) {
  const name = worktreeName(arg, cwd);
  if (!name) return emit('refused', { error: 'bad_name', hint: 'uso: node scripts/worktree.mjs --done <nome ou branch da worktree>' }, 2);
  const main = mainOf(cwd);
  if (!main) return emit('refused', { error: 'not_a_repo' }, 2);
  const path = join(main, '.worktrees', name);
  if (!existsSync(path)) return emit('refused', { error: 'not_found', path: fwd(path) }, 2);
  const branch = git(path, ['branch', '--show-current']).out;
  const tip = git(path, ['rev-parse', 'HEAD']).out;
  const base = baseOf(main, baseOpt);
  const fetched = git(main, ['fetch', '--prune', 'origin']);
  if (!fetched.ok) return emit('failed', { stage: 'fetch', detail: fetched.err.slice(0, 300) }, 3);
  const removed = dropWorktree(main, path);
  if (!removed.ok) return emit('refused', { error: 'dirty', path: fwd(path), detail: removed.err.slice(0, 300), hint: 'commite ou descarte as alterações antes (nada foi removido)' }, 2);
  const fields = { path: fwd(path), worktree: 'removed' };
  if (!branch) Object.assign(fields, { branch: 'none', reason: 'HEAD solto, nenhuma branch' });
  else if (branch === base) Object.assign(fields, { branch: 'kept', reason: `é a branch base ${base}` });
  else {
    const proof = mergedProof(main, branch, tip, base);
    const deleted = proof.merged && git(main, ['branch', '-D', branch]);
    if (deleted?.ok) Object.assign(fields, { branch: `deleted ${branch} (${proof.how})`, pr: proof.pr ? `#${proof.pr.number} mergeCommit ${short(proof.pr.mergeCommit?.oid ?? '') || '-'}` : undefined });
    else Object.assign(fields, { branch: `kept ${branch}`, reason: proof.merged ? `não consegui apagar: ${deleted.err.split('\n')[0].slice(0, 160)}` : proof.reason, next: `trabalho único em ${branch}: confira a PR antes de apagar` });
  }
  fields.main = fastForwardBase(main, base);
  fields.head = git(main, ['log', '-1', '--format=%h %s', `refs/heads/${base}`]).out;
  return emit('done', fields, 0);
}

// Conflict hunks git cannot merge but that are no judgment call: both sides are only whole import/require lines.
const IMPORT_LINES = [
  /^\s*import\s+(?:type\s+)?[\w$*{}\s,]+?\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/,
  /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/,
  /^\s*(?:const|let|var)\s+[\w${}\s,:]+=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*(?:\.\w+)?\s*;?\s*$/,
];
const importModule = (line) => { for (const re of IMPORT_LINES) { const m = re.exec(line); if (m) return m[1]; } return undefined; };
const bare = (line) => line.replace(/\r?\n$/, '');

/** The union of two import-only sides (ours first, then what only theirs has), or undefined when the hunk is not safely that: an empty side (a deletion), a non-import line, or each side holding a different line from the same module (both edited one import). */
function unionImports(ours, theirs) {
  if (!ours.length || !theirs.length) return undefined;
  const mods = new Map();
  for (const l of [...ours, ...theirs]) { const m = importModule(bare(l)); if (m === undefined) return undefined; mods.set(bare(l).trim(), m); }
  const keys = (side) => new Set(side.map((l) => bare(l).trim()));
  const a = keys(ours); const b = keys(theirs);
  const onlyA = new Set([...a].filter((k) => !b.has(k)).map((k) => mods.get(k)));
  if ([...b].some((k) => !a.has(k) && onlyA.has(mods.get(k)))) return undefined;
  const eol = /\r\n$/.test(ours[0]) ? '\r\n' : '\n';
  const seen = new Set();
  return [...ours, ...theirs].filter((l) => !seen.has(bare(l).trim()) && seen.add(bare(l).trim())).map((l) => `${bare(l)}${eol}`);
}

/** Resolves the import-only hunks of a conflicted file's text; what remains is listed with its line in the new text. Undefined when the markers are not well formed. */
function resolveImportHunks(text) {
  const src = text.split(/(?<=\n)/);
  const kept = [];
  const remaining = [];
  let resolved = 0;
  for (let i = 0; i < src.length; i++) {
    if (!/^<<<<<<<( |\r?\n?$)/.test(src[i])) { if (/^(=======|>>>>>>>)/.test(src[i])) return undefined; kept.push(src[i]); continue; }
    const ours = []; const theirs = []; let side = ours; let j = i + 1;
    for (; j < src.length && !/^>>>>>>>( |\r?\n?$)/.test(src[j]); j++) {
      if (/^<<<<<<<( |\r?\n?$)|^\|\|\|\|\|\|\|/.test(src[j])) return undefined;
      if (/^=======\r?\n?$/.test(src[j]) && side === ours) side = theirs; else side.push(src[j]);
    }
    if (j >= src.length || side === ours) return undefined;
    const union = unionImports(ours, theirs);
    if (union) { kept.push(...union); resolved++; } else {
      remaining.push({ line: kept.length + 1, ours: bare(ours[0] ?? '(vazio)').trim().slice(0, 70), theirs: bare(theirs[0] ?? '(vazio)').trim().slice(0, 70) });
      kept.push(...src.slice(i, j + 1));
    }
    i = j;
  }
  return { text: kept.join(''), resolved, remaining };
}

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
function unmergedFiles(path) {
  const parts = git(path, ['status', '--porcelain=v1', '-z']).out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    if (UNMERGED.has(code)) files.push({ code, file: parts[i].slice(3) });
    else if (code[0] === 'R' || code[0] === 'C') i++;
  }
  return files;
}
function operationOf(path) {
  const at = (n) => resolve(path, git(path, ['rev-parse', '--git-path', n]).out);
  if (existsSync(at('rebase-merge')) || existsSync(at('rebase-apply'))) return 'rebase';
  return existsSync(at('MERGE_HEAD')) ? 'merge' : '';
}
const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } };

/** Walks an operation stopped on conflicts to its end: resolves the import-only hunks, stages a file the operator finished by hand, continues. Returns the conflicts it cannot settle (none when the operation completed). */
function settle(path, resolvedFiles) {
  for (let round = 0; round < 500; round++) {
    const mode = operationOf(path);
    if (!mode) return { mode, conflicts: [] };
    const conflicts = [];
    for (const { code, file } of unmergedFiles(path)) {
      const text = code === 'UU' || code === 'AA' ? readText(join(path, file)) : undefined;
      const result = text === undefined ? undefined : resolveImportHunks(text);
      if (!result) { conflicts.push({ file, line: '-', ours: `(${code}: sem marcadores de texto)`, theirs: '', count: 1 }); continue; }
      if (result.resolved) { writeFileSync(join(path, file), result.text); resolvedFiles.push(`${file} (${result.resolved})`); }
      if (result.remaining.length) { conflicts.push({ file, ...result.remaining[0], count: result.remaining.length }); continue; }
      git(path, ['add', '--', file]);
    }
    if (conflicts.length) return { mode, conflicts };
    const step = mode === 'rebase' ? git(path, ['rebase', '--continue']) : git(path, ['commit', '--no-edit']);
    if (step.ok) { if (mode === 'merge') return { mode, conflicts: [] }; continue; }
    if (mode === 'rebase' && git(path, ['diff', '--cached', '--quiet']).ok && !unmergedFiles(path).length && git(path, ['rebase', '--skip']).ok) continue;
    if (unmergedFiles(path).length) continue;
    return { mode, conflicts: [], failed: step.err.split('\n')[0].slice(0, 200) };
  }
  return { mode: operationOf(path), conflicts: [], failed: 'limite de passos' };
}

function runCheck(path, command) {
  const r = spawnSync(command, { cwd: path, shell: true, encoding: 'utf8', timeout: 1_200_000, maxBuffer: 16 * 1024 * 1024 });
  return { rc: r.status ?? (r.error ? 127 : 1), tail: lines(`${r.stdout ?? ''}\n${r.stderr ?? ''}`).slice(-12) };
}

function updateWorktree(arg, cwd, opts) {
  const name = worktreeName(arg, cwd);
  if (!name) return emit('refused', { error: 'bad_name', hint: 'uso: node scripts/worktree.mjs --update <nome ou branch da worktree> [--check "<cmd>"]' }, 2);
  const main = mainOf(cwd);
  if (!main) return emit('refused', { error: 'not_a_repo' }, 2);
  const path = join(main, '.worktrees', name);
  if (!existsSync(path)) return emit('refused', { error: 'not_found', path: fwd(path) }, 2);
  const ref = `origin/${baseOf(main, opts.base)}`;
  const script = fwd(fileURLToPath(import.meta.url));
  const resumed = operationOf(path);
  if (!resumed) {
    if (!git(path, ['branch', '--show-current']).out) return emit('refused', { error: 'detached', hint: 'HEAD solto: entre numa branch antes' }, 2);
    if (lines(git(path, ['status', '--porcelain', '--untracked-files=no']).out).length) return emit('refused', { error: 'dirty', path: fwd(path), hint: 'commite ou descarte as alterações antes' }, 2);
  }
  const fetched = git(main, ['fetch', '--prune', 'origin']);
  if (!fetched.ok) return emit('failed', { stage: 'fetch', detail: fetched.err.slice(0, 300) }, 3);
  const branch = git(path, ['branch', '--show-current']).out || git(path, ['rev-parse', '--abbrev-ref', 'ORIG_HEAD']).out;
  const pushed = !!branch && git(main, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).ok;
  const before = git(path, ['rev-parse', 'HEAD']).out;
  const resolvedFiles = [];
  let result = { mode: resumed, conflicts: [] };
  if (resumed) result = settle(path, resolvedFiles);
  else if (!git(path, ['merge-base', '--is-ancestor', ref, 'HEAD']).ok) {
    const mode = pushed ? 'merge' : 'rebase';
    const started = pushed ? git(path, ['merge', '--no-edit', ref]) : git(path, ['rebase', ref]);
    result = { mode, conflicts: [] };
    if (!started.ok) {
      if (!operationOf(path)) return emit('failed', { stage: mode, detail: started.err.split('\n')[0].slice(0, 300), hint: 'nada foi alterado' }, 3);
      result = settle(path, resolvedFiles);
    }
  }
  const mode = result.mode || (pushed ? 'merge' : 'rebase');
  const resolvedRow = resolvedFiles.length ? { resolved: `import-only: ${resolvedFiles.join(', ')}` } : {};
  if (result.conflicts.length) {
    const rows = result.conflicts.map((c) => `conflict: ${c.file}:${c.line} | ours: ${c.ours} | theirs: ${c.theirs} | hunks: ${c.count}`);
    return emit('conflict', { mode, ...resolvedRow, files: result.conflicts.length, note: mode === 'rebase' ? `ours = ${ref}, theirs = o commit da branch` : `ours = a branch, theirs = ${ref}`, next: `resolva, git -C ${fwd(path)} add <arquivos> e rode de novo: node ${script} --update ${name}${opts.check ? ` --check "${opts.check}"` : ''}; desistir: git -C ${fwd(path)} ${mode} --abort` }, 3, rows);
  }
  if (result.failed) return emit('failed', { stage: mode, detail: result.failed, next: `git -C ${fwd(path)} status` }, 3);
  const head = git(path, ['rev-parse', 'HEAD']).out;
  const [behind, ahead] = git(path, ['rev-list', '--left-right', '--count', `${ref}...HEAD`]).out.split(/\s+/);
  const unpushed = pushed ? Number(git(path, ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`]).out) : 0;
  const fields = {
    mode, path: fwd(path), ...resolvedRow,
    head: `${short(head)} ${git(path, ['log', '-1', '--format=%s']).out}`,
    ahead_behind: `${ahead}/${behind} vs ${ref}`,
    diffstat: git(path, ['diff', '--shortstat', `${ref}...HEAD`]).out || 'sem diferença',
    push: !pushed ? 'n/a (branch ainda não está no origin)' : unpushed ? 'needed' : 'up to date',
  };
  let code = 0;
  let rows = [];
  if (opts.check) {
    const check = runCheck(path, opts.check);
    fields.check = `rc=${check.rc}: ${opts.check}`;
    if (check.rc) { code = 3; rows = check.tail.map((l) => `check_out: ${l.slice(0, 200)}`); }
  }
  return emit(code ? 'check_failed' : head === before ? 'up_to_date' : 'updated', fields, code, rows);
}

function createWorktree(argv, cwd = process.cwd()) {
  if (argv.some((a) => a === '--help' || a === '-h')) {
    process.stdout.write('usage: worktree.mjs <name> [--branch NOME] [--base BRANCH] | --remove <name> | --list [--all] | --done <name> | --update <name> [--check "<cmd>"]\n');
    return 0;
  }
  if (argv[0] === '--list') return listWorktrees(cwd, argv[1] === '--all');
  if (argv[0] === '--remove') return removeWorktree(argv[1] ?? '', cwd);
  if (argv[0] === '--done' || argv[0] === '--update') {
    const opts = { base: '', check: '' };
    for (let i = 2; i < argv.length; i++) {
      const flag = argv[i];
      if (!(flag === '--base' || (flag === '--check' && argv[0] === '--update')) || argv[i + 1] === undefined) return emit('refused', { error: 'bad_args', hint: `uso: node scripts/worktree.mjs ${argv[0] === '--done' ? '--done <nome> [--base BRANCH]' : '--update <nome> [--check "<cmd>"] [--base BRANCH]'}` }, 2);
      opts[flag.slice(2)] = argv[++i];
    }
    return argv[0] === '--done' ? doneWorktree(argv[1] ?? '', cwd, opts.base) : updateWorktree(argv[1] ?? '', cwd, opts);
  }
  const opts = { name: '', branch: '', base: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--branch' || arg === '--base') {
      if (argv[i + 1] === undefined) return out('refused', { error: 'missing_value', hint: `${arg} precisa de um valor` }, 2);
      opts[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith('-') || opts.name) return out('refused', { error: 'bad_args', hint: 'uso: node scripts/worktree.mjs <nome> [--branch NOME] [--base BRANCH]' }, 2);
    else opts.name = arg;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.name)) return out('refused', { error: 'bad_name', hint: 'o nome vira pasta em .worktrees/: letras, números, ponto, hífen e sublinhado' }, 2);
  const common = git(cwd, ['rev-parse', '--git-common-dir']);
  if (!common.ok) return out('refused', { error: 'not_a_repo', hint: common.err.slice(0, 200) }, 2);
  const main = resolve(cwd, common.out, '..');
  const base = opts.base || git(main, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).out.replace(/^origin\//, '') || 'main';
  const branch = opts.branch || `wt/${opts.name}`;
  const path = join(main, '.worktrees', opts.name);
  if (existsSync(path)) return out('refused', { error: 'exists', path, hint: 'já existe: reutilize essa pasta ou remova-a antes' }, 2);
  if (git(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok) return out('refused', { error: 'branch_exists', branch, hint: 'escolha outro --branch' }, 2);
  const fetched = git(main, ['fetch', 'origin', base]);
  if (!fetched.ok) return out('failed', { stage: 'fetch', detail: fetched.err.slice(0, 300) }, 3);
  const added = git(main, ['worktree', 'add', path, '-b', branch, `origin/${base}`]);
  if (!added.ok) return out('failed', { stage: 'worktree_add', detail: added.err.slice(0, 300) }, 3);
  let modules = 'absent';
  if (existsSync(join(main, 'node_modules'))) {
    try { symlinkSync(join(main, 'node_modules'), join(path, 'node_modules'), 'junction'); modules = 'linked'; }
    catch (error) { return out('failed', { stage: 'node_modules', path, detail: String(error.message).slice(0, 300), next: 'o worktree existe; crie a junção à mão' }, 3); }
  }
  return out('created', { path, branch, base: `origin/${base}`, node_modules: modules, next: `cd ${path}; ao terminar: node ${join(dirname(fileURLToPath(import.meta.url)), 'ship.mjs')} -m "assunto" -b "descrição" <arquivos>` }, 0);
}

process.exitCode = createWorktree(process.argv.slice(2));
