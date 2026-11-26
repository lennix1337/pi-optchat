import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandWords, segments } from './effect-classifier.ts';

/**
 * A pull request is merged only over green CI. A `gh pr merge` is checked here first and runs only when every check on
 * the PR's head passed. `--auto` may also run while checks are pending when GitHub will wait for them (merge state
 * BLOCKED by required checks); in a repository without required checks GitHub merges an `--auto` request at once, so
 * it is held to the same rule. Failing, pending or unreadable checks refuse the merge with the reason (the operator
 * once saw merges land over red CI). `--admin`, which skips the checks, is an effect the approval gate reserves for him.
 *
 * One exception: a failing check whose Actions job never ran a step (GitHub refused to start it: billing or spending
 * limit) tested nothing, so it does not block once the repository's own verification passed on that exact head:
 * `scripts/local-verify.mjs` leaves a receipt named after the commit in the local-verify folder.
 */
export const localVerifyDir = () => process.env.PI_LOCAL_VERIFY_DIR ?? join(homedir(), '.pi', 'agent', 'local-verify');
const locallyVerified = (sha?: string) => !!sha && /^[0-9a-f]{40}$/.test(sha) && existsSync(join(localVerifyDir(), `${sha}.json`));
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
type Rollup = { statusCheckRollup?: Check[]; mergeStateStatus?: string; headRefOid?: string; headRepository?: { name?: string }; body?: string };
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** Why the PR's checks do not allow the merge now, or undefined when every check passed (or GitHub will wait, for --auto). */
export function ciProblem(view: Rollup, auto = false): string | undefined {
  const checks = view.statusCheckRollup ?? [];
  if (!checks.length) return 'no CI check ran on this PR';
  const failed = checks.filter(c => (c.conclusion && !PASSED.has(c.conclusion)) || (c.state && ['FAILURE', 'ERROR'].includes(c.state)));
  if (failed.length) return `failing checks: ${failed.map(c => c.name ?? c.context ?? '?').slice(0, 5).join(', ')}`;
  const pending = checks.filter(c => (c.status && c.status !== 'COMPLETED') || (c.state && ['PENDING', 'EXPECTED'].includes(c.state)));
  if (pending.length && !(auto && view.mergeStateStatus === 'BLOCKED')) return `checks still running: ${pending.map(c => c.name ?? c.context ?? '?').slice(0, 5).join(', ')}`;
  if (view.mergeStateStatus === 'UNSTABLE' || view.mergeStateStatus === 'DIRTY') return `merge state ${view.mergeStateStatus}`;
  return undefined;
}


/** The major findings ship.mjs's Revisor left open in the PR description (its `ship:revisor` block), as `file:line`. Parses exactly
 * the line scripts/ship-review.mjs findingLine writes (`- [code:severity] file:line: text`); a line whose first severity tag is `[code:major]` counts wherever the tag sits (list marks, a
 * label or an unrelated `[a:b]` before it) even when the rest is malformed; a major tag quoted after a minor's own tag does not, while a severity named in prose is not a finding. */
export function openMajors(body?: string | null): string[] {
  const block = /<!-- ship:revisor:start -->([\s\S]*?)<!-- ship:revisor:end -->/.exec(body ?? '')?.[1] ?? '';
  const majors = block.split('\n').flatMap(line => {
    const tag = /\[[\w./-]+\s*:\s*(major|blocker|critical|minor|nit|info|suggestion)\s*\]\W*(?:(\S+?): )?/iu.exec(line);
    return tag && /^(?:major|blocker|critical)$/iu.test(tag[1]) ? [tag[2] ?? 'sem local'] : [];
  });
  return /^O revisor pediu mudanças sem detalhar\.$/mu.test(block) ? [...majors, 'sem local'] : majors;
}

async function neverStarted(view: Rollup, exec: Exec, cwd: string): Promise<boolean> {
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

export async function mergeRefusal(command: string, cwd: string, exec: Exec): Promise<string | undefined> {
  for (const merge of directMerges(command, cwd)) {
    const variable = [merge.pr, merge.repo].find(value => value?.includes('$'));
    if (variable) return `Not run: the PR of \`gh pr merge\` comes from a shell variable (${variable}), so its checks cannot be read before the command runs. Write it out: one \`gh pr merge <N>\` per PR, several may share one command.`;
    const args = ['pr', 'view', ...(merge.pr ? [merge.pr] : []), ...(merge.repo ? ['--repo', merge.repo] : []), '--json', 'statusCheckRollup,mergeStateStatus,headRefOid,headRepository,body'];
    let problem: string | undefined;
    try {
      const out = await exec('gh', args, { cwd: merge.dir, timeout: 20_000 });
      if (out.code !== 0 && /no pull requests found/i.test(out.stderr)) return `Not run: PR ${merge.pr ?? '(current branch)'} does not exist yet, so its checks cannot be read. When this command creates it, merge in a separate call afterwards, or let ship.mjs commit, push, open it and queue the merge in one step.`;
      if (out.code !== 0 || out.killed) problem = `could not read its checks (${(out.stderr || 'gh failed').trim().slice(0, 160)})`;
      else {
        const view = JSON.parse(out.stdout) as Rollup;
        const majors = openMajors(view.body);
        if (majors.length) return `Not run: PR ${merge.pr ?? '(current branch)'} still has open major findings from the Revisor (${majors.slice(0, 5).join(', ')}). Fix each with a red-first test and rerun \`node scripts/ship.mjs --pr ${merge.pr ?? '<N>'}\`, which reviews the new head, rewrites the block and queues the merge; a finding you judge wrong goes back to the Revisor through that rerun with the evidence in the PR (a test or log), never past it by hand.`;
        problem = ciProblem(view, merge.auto);
        const noChecks = problem?.startsWith('no CI check');
        if (noChecks || (problem?.startsWith('failing checks') && await neverStarted(view, exec, merge.dir))) {
          problem = locallyVerified(view.headRefOid) ? undefined : `${noChecks ? 'no CI check ran on this PR' : 'its CI never started (billing)'} and no local verification receipt exists for head ${view.headRefOid?.slice(0, 8) ?? '?'}: check out that head and run \`node ~/projetos/pi-optchat/scripts/local-verify.mjs <repo-dir>\`, then merge`;
        }
        else if (problem?.startsWith('failing checks') && (view.statusCheckRollup ?? []).some(c => c.status && c.status !== 'COMPLETED')) problem += ' (another check is still running: a billing-refused job is only waved through once every check has finished, so retry the same merge in a few seconds; never `--admin`)';
      }
    } catch (error) { problem = `could not read its checks (${error instanceof Error ? error.message.slice(0, 160) : 'gh failed'})`; }
    if (problem) return `Not run: PR ${merge.pr ?? '(current branch)'} is not mergeable over green CI: ${problem}. Wait for the checks (gitwatch wakes you) or fix the CI; \`--auto\` only waits where the repository requires checks.`;
  }
  return undefined;
}

export async function freezeGreen(command: string, cwd: string, exec: Exec): Promise<{ reason?: string; note?: string }> {
  let note: string | undefined;
  for (const segment of segments(command, cwd, true)) {
    const words = commandWords(segment.command).map(unquote);
    const exe = words[0]?.replace(/\.exe$/i, '').split(/[/\\]/).at(-1);
    let dir = segment.dir;
    let branch: string | undefined;
    if (exe === 'git') {
      let i = 1;
      while (words[i] === '-C' && words[i + 1]) { dir = resolve(dir, words[i + 1]!); i += 2; }
      if (words[i] !== 'push') continue;
      const args = words.slice(i + 1).filter(w => !w.startsWith('-'));
      const ref = args[1];
      branch = ref?.includes(':') ? ref.split(':').at(-1)?.replace(/^refs\/heads\//, '') : ref;
      if (branch === 'HEAD') branch = undefined;
      if (ref?.startsWith(':')) continue;
    } else if (exe === 'node' && /(?:^|[/\\])ship\.mjs$/.test(words[1] ?? '')) {
      if (words.includes('--pr') || words.includes('--dry-run') || words.includes('--help')) continue;
      const at = words.indexOf('--branch');
      if (at >= 0) branch = words[at + 1];
    } else continue;
    try {
      const out = await exec('gh', ['pr', 'view', ...(branch ? [branch] : []), '--json', 'state,statusCheckRollup,mergeStateStatus'], { cwd: dir, timeout: 20_000 });
      if (out.code !== 0 && /no pull requests found/i.test(out.stderr)) continue;
      if (out.code !== 0 || out.killed) { note = `Freeze-green: could not read PR checks (${(out.stderr || 'gh failed').trim().slice(0, 160)}); allowing push.`; continue; }
      const view = JSON.parse(out.stdout) as Rollup & { state?: string };
      if (view.state === 'OPEN' && view.mergeStateStatus !== 'BEHIND' && !ciProblem(view)) return { reason: 'Not run: the PR passed its checks. Changes after green need a reported failure (red check or review finding) or an explicit operator order; open a new PR instead.' };
    } catch (error) {
      note = `Freeze-green: could not read PR checks (${error instanceof Error ? error.message.slice(0, 160) : 'gh failed'}); allowing push.`;
    }
  }
  return { note };
}

/** Main session and subagents alike: a direct merge waits for green CI. */
export function registerMergeCiGuard(pi: ExtensionAPI, exec: Exec = (command, args, options) => pi.exec(command, args, options)) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash' && event.toolName !== 'shell_start') return;
    const command = (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string') return;
    if (/\bgh\b[^\n]*\bpr\b[^\n]*\bmerge\b/.test(command)) {
      const reason = await mergeRefusal(command, ctx?.cwd ?? process.cwd(), exec);
      if (reason) return { block: true, reason };
    }
    const frozen = await freezeGreen(command, ctx?.cwd ?? process.cwd(), exec);
    if (frozen.note) ctx?.ui.notify(frozen.note, 'warning');
    return frozen.reason ? { block: true, reason: frozen.reason } : undefined;
  });
}
