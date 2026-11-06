#!/usr/bin/env node
// Creates a task worktree in one command: fetch, `.worktrees/<name>` on a new branch from origin/<base>, and a
// node_modules junction to the main checkout, so the first test run needs no manual setup.
// Usage: node scripts/worktree.mjs <name> [--branch NOME] [--base BRANCH]
//        node scripts/worktree.mjs --remove <name>   (drops the junction first, refuses a dirty worktree, deletes the branch only if merged)
// Output is a flat key: value block ending in `rc:`; exit 0 created, 2 refused, 3 failed.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = (status, fields, code) => {
  const lines = Object.entries({ status, ...fields }).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${JSON.stringify(v).replace(/^"|"$/g, '')}`);
  process.stdout.write(`${lines.join('\n')}\nrc: ${code}\n`);
  return code;
};
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr || r.stdout || r.error?.message || '').trim() };
};

function mainOf(cwd) {
  const common = git(cwd, ['rev-parse', '--git-common-dir']);
  return common.ok ? resolve(cwd, common.out, '..') : '';
}

function removeWorktree(name, cwd) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return out('refused', { error: 'bad_name', hint: 'uso: node scripts/worktree.mjs --remove <nome>' }, 2);
  const main = mainOf(cwd);
  if (!main) return out('refused', { error: 'not_a_repo' }, 2);
  const path = join(main, '.worktrees', name);
  if (!existsSync(path)) return out('refused', { error: 'not_found', path }, 2);
  const branch = git(path, ['branch', '--show-current']).out;
  const link = join(path, 'node_modules');
  const linked = existsSync(link) && lstatSync(link).isSymbolicLink();
  if (linked) rmSync(link, { recursive: false, force: true }); // the link itself, never the main node_modules behind it
  const removed = git(main, ['worktree', 'remove', path]);
  if (!removed.ok) {
    if (linked) symlinkSync(join(main, 'node_modules'), link, 'junction');
    return out('refused', { error: 'dirty', path, detail: removed.err.slice(0, 300), hint: 'commite ou descarte as alterações antes de remover' }, 2);
  }
  rmSync(path, { recursive: false, force: true });
  git(main, ['worktree', 'prune']);
  const deleted = branch && git(main, ['branch', '-d', branch]).ok;
  return out('removed', { path, branch: !branch ? 'none' : deleted ? 'deleted' : 'kept', next: branch && !deleted ? `branch ${branch} tem commits não mesclados` : undefined }, 0);
}

function createWorktree(argv, cwd = process.cwd()) {
  if (argv[0] === '--remove') return removeWorktree(argv[1] ?? '', cwd);
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
