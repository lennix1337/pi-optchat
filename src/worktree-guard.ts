import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { commandWords, segments } from './effect-classifier.ts';

const unquote = (word: string) => word.replace(/^(['"])([^]*)\1$/, '$2');
type Target = { path: string; repo: string };

/** Literal destructive worktree targets; this is not a shell interpreter. */
export function worktreeRemovalTargets(text: string, cwd: string): Target[] {
  const targets: Target[] = [];
  for (const segment of segments(text, cwd, true)) {
    const words = commandWords(segment.command).map(unquote);
    const name = words.shift()?.toLowerCase();
    let repo = segment.dir;
    if (name === 'git') {
      while (words[0] === '-C' && words[1]) { repo = resolve(repo, words[1]); words.splice(0, 2); }
      if (words[0] !== 'worktree' || words[1] !== 'remove') continue;
      const args = words.slice(2);
      if (!args.some(arg => arg === '--force' || /^-[^-]*f/.test(arg))) continue;
      for (const arg of args.filter(arg => !arg.startsWith('-'))) targets.push({ path: resolve(repo, arg), repo });
    } else if (name === 'rm' || name === 'remove-item') {
      const args = words;
      const recursive = args.some(arg => name === 'rm' ? /^-[^-]*r/i.test(arg) || arg === '--recursive' : /^-recurse$/i.test(arg));
      const force = name === 'remove-item' || args.some(arg => /^-[^-]*f/.test(arg) || arg === '--force');
      if (!recursive || !force) continue;
      for (const arg of args.filter(arg => !arg.startsWith('-'))) targets.push({ path: resolve(segment.dir, arg), repo: resolve(segment.dir, arg) });
    }
  }
  return targets;
}

const exec = promisify(execFile);


async function run(command: string, args: string[], cwd: string, timeout = 2000): Promise<string | undefined> {
  try { return (await exec(command, args, { cwd, timeout, encoding: 'utf8', windowsHide: true })).stdout.trim(); }
  catch { return undefined; }
}

type MergedPr = (branch: string | undefined, repo: string, head: string | undefined) => boolean | Promise<boolean>;


async function mergedPr(branch: string | undefined, repo: string, head: string | undefined) {
  const found = async (args: string[], match: (pr: { headRefOid?: string }) => boolean) => {
    const output = await run('gh', ['pr', 'list', '--state', 'merged', ...args, '--json', 'number,headRefOid'], repo, 3000);
    try { const prs: unknown = JSON.parse(output ?? ''); return Array.isArray(prs) && prs.some(match); } catch { return false; }
  };
  return Boolean(branch && await found(['--head', branch], () => true)) || Boolean(head && await found(['--search', head], pr => pr.headRefOid === head));
}

// external: Windows realpath expands 8.3 short names.
const key = (path: string) => { try { return realpathSync.native(path).toLowerCase(); } catch { return resolve(path).toLowerCase(); } };
const within = (path: string, dir: string) => key(path) === key(dir) || key(path).startsWith(key(dir).replace(/[\\/]$/, '') + sep);


async function cleanAndPushed(path: string, head: string | undefined) {
  if (!head || await run('git', ['status', '--porcelain'], path) !== '') return false;
  return Boolean(await run('git', ['for-each-ref', '--count=1', '--contains', head, '--format=%(refname)', 'refs/remotes'], path));
}

/** Refuse a registered worktree unless its tip is proven merged into origin's default or a merged PR, or it is clean and already pushed. */
export async function worktreeRemovalRefusal(text: string, cwd: string, hasMergedPr: MergedPr = mergedPr): Promise<string | undefined> {
  for (const target of worktreeRemovalTargets(text, cwd)) {
    const list = await run('git', ['worktree', 'list', '--porcelain'], target.repo);
    if (!list) {

      if (existsSync(join(target.path, '.git'))) return `Blocked removal of ${target.path}: Git could not list its worktrees, so its merge state is unknown.`;
      continue;
    }

    for (const entry of list.split(/\r?\n\r?\n/).slice(1)) {
      const path = /^worktree (.+)$/m.exec(entry)?.[1]?.trim();
      if (!path || !within(path, target.path)) continue;
      const branch = /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1]?.trim();
      const head = /^HEAD ([a-f0-9]+)$/m.exec(entry)?.[1];
      const base = await run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], target.repo);
      const ancestor = head && base && await run('git', ['merge-base', '--is-ancestor', head, base], target.repo) !== undefined;
      if (!ancestor && !((branch || head) && await hasMergedPr(branch, target.repo, head)) && !await cleanAndPushed(path, head)) return `Blocked removal of worktree ${path} (branch ${branch ?? 'detached HEAD'}): removal of unmerged worktrees needs the operator's explicit order.`;
    }
  }
  return undefined;
}
