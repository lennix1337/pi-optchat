import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { commandWords, segments } from './effect-classifier.ts';

/**
 * A pull request is merged only over green CI. A `gh pr merge` is checked here first and runs only when every check on
 * the PR's head passed. `--auto` may also run while checks are pending when GitHub will wait for them (merge state
 * BLOCKED by required checks); in a repository without required checks GitHub merges an `--auto` request at once, so
 * it is held to the same rule. Failing, pending or unreadable checks refuse the merge with the reason (the operator
 * once saw merges land over red CI). `--admin`, which skips the checks, is an effect the approval gate reserves for him.
 *
 * One exception, approved by the operator on 09/11 when Actions ran out of minutes: a failing check whose Actions job
 * never ran a step (GitHub refused to start it: billing or spending limit) is covered by a passing local gate verdict
 * (dotfiles payload/tools/local-gate, `<gate dir>/<repo>.json`) recorded for the PR's exact head commit.
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

type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string };
type Rollup = { statusCheckRollup?: Check[]; mergeStateStatus?: string; headRefOid?: string; headRepository?: { name?: string } };
export type LocalGate = { dir: () => string | undefined; read?: (file: string) => string };
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

/** True when every non-passing check is an Actions job that ran no step and the local gate passed on the head commit. */
async function coveredByLocalGate(view: Rollup, exec: Exec, cwd: string, gate?: LocalGate): Promise<boolean> {
  const dir = gate?.dir(), sha = view.headRefOid, repo = view.headRepository?.name;
  if (!dir || !sha || !repo) return false;
  try {
    const verdict = JSON.parse((gate!.read ?? (file => readFileSync(file, 'utf8')))(join(dir, `${repo}.json`))) as { sha?: string; ok?: boolean };
    if (verdict.ok !== true || verdict.sha !== sha) return false;
  } catch { return false; }
  const open = (view.statusCheckRollup ?? []).filter(c => !(c.conclusion && PASSED.has(c.conclusion)));
  if (!open.length) return false;
  for (const check of open) {
    const job = check.conclusion === 'FAILURE' ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)/.exec(check.detailsUrl ?? '') : null;
    if (!job) return false;
    const out = await exec('gh', ['api', `repos/${job[1]}/actions/jobs/${job[2]}`, '--jq', '.steps | length'], { cwd, timeout: 20_000 }).catch(() => undefined);
    if (!out || out.code !== 0 || out.killed || out.stdout.trim() !== '0') return false;
  }
  return true;
}

export async function mergeRefusal(command: string, cwd: string, exec: Exec, gate?: LocalGate): Promise<string | undefined> {
  for (const merge of directMerges(command, cwd)) {
    const args = ['pr', 'view', ...(merge.pr ? [merge.pr] : []), ...(merge.repo ? ['--repo', merge.repo] : []), '--json', 'statusCheckRollup,mergeStateStatus,headRefOid,headRepository'];
    let problem: string | undefined;
    try {
      const out = await exec('gh', args, { cwd: merge.dir, timeout: 20_000 });
      if (out.code !== 0 || out.killed) problem = `could not read its checks (${(out.stderr || 'gh failed').trim().slice(0, 160)})`;
      else {
        const view = JSON.parse(out.stdout) as Rollup;
        problem = ciProblem(view, merge.auto);
        if (problem?.startsWith('failing checks') && await coveredByLocalGate(view, exec, merge.dir, gate)) problem = undefined;
      }
    } catch (error) { problem = `could not read its checks (${error instanceof Error ? error.message.slice(0, 160) : 'gh failed'})`; }
    if (problem) return `Not run: PR ${merge.pr ?? '(current branch)'} is not mergeable over green CI: ${problem}. Wait for the checks (gitwatch wakes you) or fix the CI; \`--auto\` only waits where the repository requires checks.`;
  }
  return undefined;
}

/** Main session and subagents alike: a direct merge waits for green CI. */
export function registerMergeCiGuard(pi: ExtensionAPI, gate?: LocalGate, exec: Exec = (command, args, options) => pi.exec(command, args, options)) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash' && event.toolName !== 'shell_start') return;
    const command = (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string' || !/\bgh\b[^\n]*\bpr\b[^\n]*\bmerge\b/.test(command)) return;
    const reason = await mergeRefusal(command, ctx?.cwd ?? process.cwd(), exec, gate);
    return reason ? { block: true, reason } : undefined;
  });
}
