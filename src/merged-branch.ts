import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { record } from './cache.ts';

/** Runs a process in a folder and returns its trimmed stdout; throws when it fails. A runner that knows nothing returns undefined. */
export type Runner = (command: string, args: string[], cwd: string) => string | undefined;

const LOOKUP_MS = 5000;
const run: Runner = (command, args, cwd) => {
  while (!existsSync(cwd) && dirname(cwd) !== cwd) cwd = dirname(cwd);
  return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: LOOKUP_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
};

/** `origin`'s default branch as a remote ref (`origin/main`): origin/HEAD when set, else origin/main or origin/master. */
function defaultRef(path: string, runner: Runner) {
  const head = runner('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], path);
  if (head) return head;
  for (const name of ['main', 'master']) {
    try { if (runner('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`], path)) return `origin/${name}`; } catch { /* try the next one */ }
  }
  return undefined;
}

/** Whether the local branch's tip is already in the default branch: an ancestor of it, or the head of a PR merged into it (squash merges leave no ancestry). */
function landed(path: string, branch: string, runner: Runner): boolean {
  const tip = runner('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], path);
  const target = defaultRef(path, runner);
  if (!tip || !target || target === `origin/${branch}`) return false;
  try { if (runner('git', ['merge-base', '--is-ancestor', tip, target], path) !== undefined) return true; } catch { /* not an ancestor: look for a merged PR */ }
  const prs: unknown = JSON.parse(runner('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'headRefOid,baseRefName', '--limit', '10'], path) ?? '');
  return Array.isArray(prs) && prs.some(pr => record(pr) && pr.headRefOid === tip && pr.baseRefName === target.replace(/^origin\//, ''));
}

/**
 * Whether the branch of the checkout at `path` is merged, so deleting it loses nothing: its tip is reachable from
 * origin's default branch, or it is the head of a merged PR into that branch (`gh`, local tip == PR head, so nothing was
 * added after). The default branch itself never counts. Any failure or unknown answer is "not merged".
 */
export function branchMerged(path: string, branch: string, runner: Runner = run): boolean {
  if (/^(?:main|master|head)$/i.test(branch)) return false;
  try { return landed(path, branch, runner); } catch { return false; }
}

/** A linked worktree's checked-out branch and whether it has no modified or untracked files; undefined when git cannot tell. */
export function worktreeState(path: string, runner: Runner = run): { branch: string; clean: boolean } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const branch = runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], path), status = runner('git', ['status', '--porcelain'], path);
    return branch && status !== undefined ? { branch, clean: status === '' } : undefined;
  } catch { return undefined; }
}
