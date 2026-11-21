import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commandWords, normalPath, segments } from './effect-classifier.ts';

// external: Git commit executes pre-commit hooks before completing.




/** A hook can run for minutes; a foreground bash call with less timeout than this may end while the commit is still going. */
export const MIN_COMMIT_HOOK_TIMEOUT_SECONDS = 900;

const unquote = (word: string) => word.replace(/^(['"])([^]*)\1$/, '$2');

const RUNS_NO_HOOK = new Set(['--no-verify', '-n', '--dry-run']);

const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };


const exec = promisify(execFile);
async function gitLines(dir: string, args: string[]): Promise<string[] | undefined> {
  try {
    const { stdout: out } = await exec('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).filter(Boolean);
  } catch { return undefined; }
}

/**
 * The pre-commit hook git runs for a commit made in `dir`, or undefined. Git decides where hooks live: core.hooksPath when set,
 * else the repository's hooks dir, shared by linked worktrees. Husky's `.husky/pre-commit` counts as well. Only reads.
 */
export async function activePreCommitHook(dir: string): Promise<string | undefined> {
  const paths = await gitLines(dir, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  if (paths?.length !== 2) return undefined;
  const root = resolve(dir, paths[0]);
  const common = resolve(dir, paths[1]);
  const configured = (await gitLines(dir, ['config', '--get', 'core.hooksPath']))?.[0];
  const hooks = configured === undefined ? join(common, 'hooks') : resolve(root, configured);
  return [join(hooks, 'pre-commit'), join(root, '.husky', 'pre-commit')].find(isFile);
}


function hookedCommitDir(words: string[], dir: string): string | undefined {
  if (!words.length || unquote(words[0]).split(/[/\\]/).at(-1)!.replace(/\.exe$/i, '').toLowerCase() !== 'git') return undefined;
  let at = 1, path = dir;
  while (at < words.length && words[at].startsWith('-')) {
    if (words[at] === '-C' && words[at + 1] !== undefined) path = normalPath(words[++at], dir, true);
    else if (words[at] === '-c') at++;
    at++;
  }
  return words[at] === 'commit' && !words.slice(at + 1).some(word => RUNS_NO_HOOK.has(unquote(word))) ? path : undefined;
}

/** The active pre-commit hook a `git commit` in `command` would run from `cwd`, or undefined. */
export async function hookedCommit(command: string, cwd: string): Promise<string | undefined> {
  // external: Linux file paths are case-sensitive.
  for (const { command: segment, dir } of segments(command, cwd, true)) {
    const path = hookedCommitDir(commandWords(segment), dir);
    const hook = path === undefined ? undefined : await activePreCommitHook(path);
    if (hook) return hook;
  }
  return undefined;
}

/** Main session and subagents alike: a bash call that would wait on a hook for longer than its timeout is refused. */
export function registerCommitHookGuard(pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const input = event.input as { command?: unknown; timeout?: unknown } | undefined;
    if (typeof input?.command !== 'string') return;
    // external: Pi bash has no default timeout.
    if (typeof input.timeout !== 'number' || input.timeout >= MIN_COMMIT_HOOK_TIMEOUT_SECONDS) return;
    const hook = await hookedCommit(input.command, ctx?.cwd ?? process.cwd());
    if (!hook) return;
    const alternative = pi.getActiveTools().includes('shell_start') ? 'run this commit with shell_start (it reports when it ends), or ' : '';
    return { block: true, reason: `Not run: git commit runs the pre-commit hook ${hook}, which can take minutes. A foreground bash call that outlives its timeout leaves the commit's outcome uncertain and blocks later calls. ${alternative}give this bash call a timeout of at least ${MIN_COMMIT_HOOK_TIMEOUT_SECONDS} s.` };
  });
}
