import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { record } from './cache.ts';

/** Runs a process in a folder and returns its trimmed stdout; throws when it fails. A runner that knows nothing returns undefined. */
export type Runner = (command: string, args: string[], cwd: string) => string | undefined | Promise<string | undefined>;

const LOOKUP_MS = 5000;
const exec = promisify(execFile);
const run: Runner = async (command, args, cwd) => {
  while (!existsSync(cwd) && dirname(cwd) !== cwd) cwd = dirname(cwd);
  return (await exec(command, args, { cwd, encoding: 'utf8', timeout: LOOKUP_MS, windowsHide: true })).stdout.trim();
};


async function defaultRef(path: string, runner: Runner) {
  try {
    const head = await runner('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], path);
    if (head) return head;
  } catch {   }
  for (const name of ['main', 'master']) {
    try { if (await runner('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`], path)) return `origin/${name}`; } catch {   }
  }
  return undefined;
}


async function landed(path: string, branch: string, runner: Runner): Promise<boolean> {
  const tip = await runner('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], path);
  const target = await defaultRef(path, runner);
  if (!tip || !target || target === `origin/${branch}`) return false;
  try { if (await runner('git', ['merge-base', '--is-ancestor', tip, target], path) !== undefined) return true; } catch {   }
  const prs: unknown = JSON.parse(await runner('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'headRefOid,baseRefName', '--limit', '10'], path) ?? '');
  return Array.isArray(prs) && prs.some(pr => record(pr) && pr.headRefOid === tip && pr.baseRefName === target.replace(/^origin\//, ''));
}

/**
 * Whether the branch of the checkout at `path` is merged, so deleting it loses nothing: its tip is reachable from
 * origin's default branch, or it is the head of a merged PR into that branch (`gh`, local tip == PR head, so nothing was
 * added after). The default branch itself never counts. Any failure or unknown answer is "not merged".
 */
export async function branchMerged(path: string, branch: string, runner: Runner = run): Promise<boolean> {
  if (/^(?:main|master|head)$/i.test(branch)) return false;
  try { return await landed(path, branch, runner); } catch { return false; }
}

/** A linked worktree's checked-out branch and whether it has no modified or untracked files; undefined when git cannot tell. */
export async function worktreeState(path: string, runner: Runner = run): Promise<{ branch: string; clean: boolean } | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const branch = await runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], path), status = await runner('git', ['status', '--porcelain'], path);
    return branch && status !== undefined ? { branch, clean: status === '' } : undefined;
  } catch { return undefined; }
}
