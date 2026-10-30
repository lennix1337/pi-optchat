import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { commandWords, segments } from './effect-classifier.ts';

/**
 * A pull request is merged only over green CI. A `gh pr merge` is checked here first and runs only when every check on
 * the PR's head passed. `--auto` may also run while checks are pending when GitHub will wait for them (merge state
 * BLOCKED by required checks); in a repository without required checks GitHub merges an `--auto` request at once, so
 * it is held to the same rule. Failing, pending or unreadable checks refuse the merge with the reason (the operator
 * once saw merges land over red CI). `--admin`, which skips the checks, is an effect the approval gate reserves for him.
 */
const unquote = (word: string) => word.replace(/^(['"])([^]*)\1$/, '$2');
export type Exec = (command: string, args: string[], options: { cwd: string; timeout: number }) => Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>;

/** The direct merges in shell text: the PR (number, URL or branch, or none = current branch), its `--repo` and folder. */
export function directMerges(command: string, cwd: string) {
  const merges: { pr?: string; repo?: string; dir: string; auto?: true }[] = [];
  for (const { command: segment, dir } of segments(command, cwd, true)) {
    const w = commandWords(segment).map(unquote);
    if (w[0]?.replace(/\.exe$/i, '').split(/[/\\]/).at(-1) !== 'gh' || w[1] !== 'pr' || w[2] !== 'merge') continue;
    const args = w.slice(3);
    if (args.some(arg => arg === '--disable-auto' || arg === '--admin' || arg === '-h' || arg === '--help')) continue;
    const at = args.findIndex(arg => arg === '-R' || arg === '--repo' || arg.startsWith('--repo='));
    const repo = at < 0 ? undefined : args[at]!.startsWith('--repo=') ? args[at]!.slice(7) : args[at + 1];
    const valueFlags = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit']);
    const pr = args.find((arg, i) => !arg.startsWith('-') && !valueFlags.has(args[i - 1] ?? ''));
    merges.push({ ...(pr ? { pr } : {}), ...(repo ? { repo } : {}), dir, ...(args.includes('--auto') ? { auto: true as const } : {}) });
  }
  return merges;
}

type Rollup = { statusCheckRollup?: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[]; mergeStateStatus?: string };
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** Why the PR's checks do not allow the merge now, or undefined when every check passed (or GitHub will wait, for --auto). */
export function ciProblem(view: Rollup, auto = false): string | undefined {
  const checks = view.statusCheckRollup ?? [];
  const failed = checks.filter(c => (c.conclusion && !PASSED.has(c.conclusion)) || (c.state && ['FAILURE', 'ERROR'].includes(c.state)));
  if (failed.length) return `failing checks: ${failed.map(c => c.name ?? c.context ?? '?').slice(0, 5).join(', ')}`;
  const pending = checks.filter(c => (c.status && c.status !== 'COMPLETED') || (c.state && ['PENDING', 'EXPECTED'].includes(c.state)));
  if (pending.length && !(auto && view.mergeStateStatus === 'BLOCKED')) return `checks still running: ${pending.map(c => c.name ?? c.context ?? '?').slice(0, 5).join(', ')}`;
  if (view.mergeStateStatus === 'UNSTABLE' || view.mergeStateStatus === 'DIRTY') return `merge state ${view.mergeStateStatus}`;
  return undefined;
}

export async function mergeRefusal(command: string, cwd: string, exec: Exec): Promise<string | undefined> {
  for (const merge of directMerges(command, cwd)) {
    const args = ['pr', 'view', ...(merge.pr ? [merge.pr] : []), ...(merge.repo ? ['--repo', merge.repo] : []), '--json', 'statusCheckRollup,mergeStateStatus'];
    let problem: string | undefined;
    try {
      const out = await exec('gh', args, { cwd: merge.dir, timeout: 20_000 });
      problem = out.code !== 0 || out.killed ? `could not read its checks (${(out.stderr || 'gh failed').trim().slice(0, 160)})` : ciProblem(JSON.parse(out.stdout) as Rollup, merge.auto);
    } catch (error) { problem = `could not read its checks (${error instanceof Error ? error.message.slice(0, 160) : 'gh failed'})`; }
    if (problem) return `Not run: PR ${merge.pr ?? '(current branch)'} is not mergeable over green CI: ${problem}. Wait for the checks (gitwatch wakes you) or fix the CI; \`--auto\` only waits where the repository requires checks.`;
  }
  return undefined;
}

/** Main session and subagents alike: a direct merge waits for green CI. */
export function registerMergeCiGuard(pi: ExtensionAPI, exec: Exec = (command, args, options) => pi.exec(command, args, options)) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash' && event.toolName !== 'shell_start') return;
    const command = (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string' || !/\bgh\b[^\n]*\bpr\b[^\n]*\bmerge\b/.test(command)) return;
    const reason = await mergeRefusal(command, ctx?.cwd ?? process.cwd(), exec);
    return reason ? { block: true, reason } : undefined;
  });
}
