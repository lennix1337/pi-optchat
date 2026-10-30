import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commandWords, normalPath, segments } from './effect-classifier.ts';

// A foreground `git commit` in a repo with a pre-commit hook runs the hook inside the bash call. dentai-mono's husky hook
// runs the full api and web suites (minutes). When the call's timeout ends first, the commit's outcome is left uncertain
// and every later bash call is refused until someone reconciles it. A commit that would run a hook is refused before it
// runs, unless its bash call allows the hook to finish (or it runs in the background with shell_start).

/** A hook can run for minutes; a foreground bash call with less timeout than this may end while the commit is still going. */
export const MIN_COMMIT_HOOK_TIMEOUT_SECONDS = 900;

const unquote = (word: string) => word.replace(/^(['"])([^]*)\1$/, '$2');
/** Flags that make `git commit` skip the hook (`-n` is `--no-verify`) or create no commit at all. */
const RUNS_NO_HOOK = new Set(['--no-verify', '-n', '--dry-run']);

const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

/** Output lines of a read-only git query run in `dir`, or undefined outside a repository or when git has no value. */
function gitLines(dir: string, args: string[]): string[] | undefined {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.split(/\r?\n/).filter(Boolean);
  } catch { return undefined; }
}

/**
 * The pre-commit hook git runs for a commit made in `dir`, or undefined. Git decides where hooks live: core.hooksPath when set,
 * else the repository's hooks dir, shared by linked worktrees. Husky's `.husky/pre-commit` counts as well. Only reads.
 */
export function activePreCommitHook(dir: string): string | undefined {
  const paths = gitLines(dir, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  if (paths?.length !== 2) return undefined;
  const root = resolve(dir, paths[0]);
  const common = resolve(dir, paths[1]);
  const configured = gitLines(dir, ['config', '--get', 'core.hooksPath'])?.[0];
  const hooks = configured === undefined ? join(common, 'hooks') : resolve(root, configured);
  return [join(hooks, 'pre-commit'), join(root, '.husky', 'pre-commit')].find(isFile);
}

/** The directory (`-C`, else the segment's) of a `git commit` that runs hooks, from the words of one command segment. */
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
export function hookedCommit(command: string, cwd: string): string | undefined {
  // Case kept: the directory is opened, and Linux paths are case-sensitive.
  for (const { command: segment, dir } of segments(command, cwd, true)) {
    const path = hookedCommitDir(commandWords(segment), dir);
    const hook = path === undefined ? undefined : activePreCommitHook(path);
    if (hook) return hook;
  }
  return undefined;
}

/** Main session and subagents alike: a bash call that would wait on a hook for longer than its timeout is refused. */
export function registerCommitHookGuard(pi: ExtensionAPI) {
  pi.on('tool_call', (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const input = event.input as { command?: unknown; timeout?: unknown } | undefined;
    if (typeof input?.command !== 'string') return;
    // Pi's bash tool has no default timeout: a call without one waits for the hook, however long it runs.
    if (typeof input.timeout !== 'number' || input.timeout >= MIN_COMMIT_HOOK_TIMEOUT_SECONDS) return;
    const hook = hookedCommit(input.command, ctx?.cwd ?? process.cwd());
    if (!hook) return;
    const alternative = pi.getActiveTools().includes('shell_start') ? 'run this commit with shell_start (it reports when it ends), or ' : '';
    return { block: true, reason: `Not run: git commit runs the pre-commit hook ${hook}, which can take minutes. A foreground bash call that outlives its timeout leaves the commit's outcome uncertain and blocks later calls. ${alternative}give this bash call a timeout of at least ${MIN_COMMIT_HOOK_TIMEOUT_SECONDS} s.` };
  });
}
