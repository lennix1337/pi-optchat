// The bash tool's output is the largest token cost of a session (7 days on 14/11: 8,187 calls, ~4.85M tokens, mostly git,
// grep and file listings). rtk (github.com/rtk-ai/rtk) rewrites common commands to compact equivalents
// (`git log` -> `rtk git log`) and keeps exit codes; `rtk rewrite` says which commands it handles. The model never types
// rtk: the bash tool rewrites before running, and `full_output: true` runs the command as written.
import { execFile } from 'node:child_process';
import { commandSegments } from './long-commands.ts';

/**
 * Rewrites that lose information a later step needs: `rtk find` drops the searched folder from paths, `rtk wc` the file
 * names, and `rtk git show <rev>:<path>` cuts the file it reads after about 115 lines.
 */
const LOSSY = /(?:^|[\s;&|(])rtk\s+(?:find\b|wc\b|git\s+show\s+\S*:)/;
const REWRITE_TIMEOUT_MS = 2000;

export const FULL_OUTPUT_PARAM = 'full_output';
export const FULL_OUTPUT_NOTE = 'Output of common commands (git, grep, ls, gh, cargo, test runners) is compacted automatically; '
  + `set ${FULL_OUTPUT_PARAM}: true to run the command exactly as written when the compact form hides what you need.`;

export type RewriteRunner = (command: string) => Promise<{ code: number | null; stdout: string } | undefined>;

/**
 * Without rtk's own agent hook, every rtk command prints a "No hook installed" line on stderr, which the bash tool would
 * return on every call; the harness is the hook, so the line is silenced, and no telemetry leaves. Bash children inherit
 * these from Pi's environment; an explicit value set by the user wins.
 */
export function prepareRtkEnvironment(env: NodeJS.ProcessEnv = process.env) {
  env.RTK_SUPPRESS_HOOK_WARNING ??= '1';
  env.RTK_TELEMETRY_DISABLED ??= '1';
}

let available = true;
const runRtk: RewriteRunner = command => new Promise(resolve => {
  if (!available) return resolve(undefined);
  execFile('rtk', ['rewrite', command], { timeout: REWRITE_TIMEOUT_MS, windowsHide: true },
    (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') available = false;
      resolve({ code, stdout: String(stdout) });
    });
});

/**
 * The command to run: rtk's compact rewrite when it has one, else the command unchanged. Fails open: a missing rtk, a
 * timeout, an unknown exit code or a lossy rewrite all run the original. Exit 0 and 3 carry a rewrite (3: rtk would ask
 * the user first in its own hook; the approval gate here already judged the original command), 1 means none.
 */
export async function compactCommand(command: string, full = false, run: RewriteRunner = runRtk): Promise<string> {
  if (full || !command.trim()) return command;
  const result = await run(command);
  if (!result || (result.code !== 0 && result.code !== 3)) return command;
  const rewritten = result.stdout.trim();
  if (!rewritten || rewritten === command.trim() || LOSSY.test(rewritten)) return command;
  return rewritten;
}

const GREP = new Set(['grep', 'egrep', 'fgrep', 'rg']);

/**
 * grep exits 1 for "no match", a valid answer that the bash tool reports as an error (676 of 1,635 tool errors in 7 days
 * of sessions). When the last command of the line is a grep and it printed nothing, the result says so and is not an
 * error; the structured exit code stays 1 for scripts.
 */
export function isEmptyGrepMiss(command: string, exitCode: unknown, output: unknown): boolean {
  if (exitCode !== 1 || typeof output !== 'string' || output.trim()) return false;
  const last = commandSegments(command).at(-1);
  if (!last) return false;
  let words = last.filter(word => !/^\w+=/.test(word));
  if (words[0] === 'rtk') words = words.slice(1);
  if (words[0] === 'git' && words[1] === 'grep') return true;
  return GREP.has((words[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, ''));
}

export const NO_MATCH_TEXT = '(no matches: grep exited 1 with no output)';
