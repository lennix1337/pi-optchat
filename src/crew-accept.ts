import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closed, readCommitments, updateCommitment } from './commitments.ts';
import type { Proposal } from './crew.ts';
import type { RunInfo } from './runs.ts';

/** What a worker's report carries after its own text, and what the manager's one-call acceptance does (see `acceptRun`). */

export interface Outcome { code: number; out: string }
/** Runs git in a directory; resolves with its exit code, rejects only when git could not run at all. */
export type GitRunner = (cwd: string, args: string[]) => Promise<Outcome>;
/** Runs scripts/ship.mjs in a directory with these arguments: stdout, and the exit code (null: killed or not started). */
export type ShipRunner = (cwd: string, args: string[]) => Promise<{ code: number | null; out: string; err: string }>;

const GIT_TIMEOUT_MS = 15_000;
const SHIP_TIMEOUT_MS = 5 * 60_000;
const SHIP_SCRIPT = fileURLToPath(new URL('../scripts/ship.mjs', import.meta.url));

export const runGit: GitRunner = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (!error) return resolve({ code: 0, out: String(stdout) });
    if (typeof error.code === 'number') return resolve({ code: error.code, out: String(stdout) });
    reject(new Error(error.killed ? `git ${args[0]} timed out` : error.message));
  });
});
export const runShip: ShipRunner = (cwd, args) => new Promise(resolve => {
  execFile(process.execPath, [SHIP_SCRIPT, ...args], { cwd, windowsHide: true, timeout: SHIP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, out: String(stdout), err: String(stderr || error?.message || '') });
  });
});

const oneLine = (text: string, max = 160) => { const line = (text.trim().split(/\r?\n/)[0] ?? '').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };
const lines = (text: string) => text.split(/\r?\n/).filter(line => line.trim());

export const APPENDIX_COMMITS = 10;
export const APPENDIX_FILES = 15;

/** The default branch to compare against: what origin's HEAD names, else origin/main; undefined when the remote ref is missing. */
async function baseOf(cwd: string, git: GitRunner) {
  const head = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const name = head.code === 0 ? head.out.trim() : 'origin/main';
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`])).code === 0 ? name : undefined;
}
const need = (step: string, got: Outcome) => { if (got.code !== 0) throw new Error(`git ${step} failed (exit ${got.code})`); return got.out; };

/** The branch, its commits ahead of the base, the diff stat and whether the tree is dirty: the facts a review starts from. */
export interface BranchState { branch: string; base: string | undefined; commits: string[]; ahead: number; stat: string[]; summary: string; dirty: string[] }
/** The state of the checkout at `cwd`; undefined when it is not a git checkout. Throws when git fails or cannot run. */
export async function branchState(cwd: string, git: GitRunner = runGit): Promise<BranchState | undefined> {
  if (!existsSync(cwd)) return undefined;
  if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])).code !== 0) return undefined;
  const [named, base, status] = await Promise.all([git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']), baseOf(cwd, git), git(cwd, ['status', '--porcelain'])]);
  const branch = named.code === 0 ? named.out.trim() : '(detached HEAD)';
  const dirty = lines(need('status', status));
  if (!base) return { branch, base, commits: [], ahead: 0, stat: [], summary: '', dirty };
  const [log, count, diff] = await Promise.all([git(cwd, ['log', '--oneline', `-${APPENDIX_COMMITS}`, `${base}..HEAD`]), git(cwd, ['rev-list', '--count', `${base}..HEAD`]), git(cwd, ['diff', '--stat=100', `${base}...HEAD`])]);
  const stat = lines(need('diff --stat', diff));
  return { branch, base, commits: lines(need('log', log)), ahead: Number(need('rev-list', count).trim()) || 0, stat: stat.slice(0, -1), summary: stat.at(-1)?.trim() ?? '', dirty };
}

/** The compact appendix a worker's report carries: branch, commits ahead of origin/main, the diff stat, a dirty-tree warning.
 * Empty when `cwd` is not a git checkout; on any failure one line saying why. It never throws: the report is delivered either way. */
export async function reportAppendix(cwd: string, git: GitRunner = runGit): Promise<string> {
  try {
    const state = await branchState(cwd, git);
    if (!state) return '';
    const out = [`[git] branch ${state.branch}: ${state.base ? `${state.ahead} commit${state.ahead === 1 ? '' : 's'} ahead of ${state.base}` : 'no origin/main to compare with'}`];
    out.push(...state.commits.map(commit => `  ${oneLine(commit)}`));
    if (state.ahead > state.commits.length) out.push(`  … ${state.ahead - state.commits.length} more`);
    if (state.summary) {
      out.push(state.summary, ...state.stat.slice(0, APPENDIX_FILES).map(file => ` ${file.trim()}`));
      if (state.stat.length > APPENDIX_FILES) out.push(` … ${state.stat.length - APPENDIX_FILES} more files`);
    }
    if (state.dirty.length) out.push(`⚠ dirty tree: ${state.dirty.length} uncommitted file${state.dirty.length === 1 ? '' : 's'} (${state.dirty.slice(0, 3).map(line => line.trim()).join(', ')}${state.dirty.length > 3 ? ', …' : ''})`);
    return out.join('\n');
  } catch (error) { return `[git] appendix unavailable: ${oneLine(error instanceof Error ? error.message : String(error), 120)}`; }
}

/** scripts/ship.mjs prints a flat `key: value` object; values with colons are JSON-quoted. */
export function parseShip(out: string) {
  const fields: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const found = /^([a-z_]+): (.*)$/.exec(line);
    if (!found) continue;
    let value = found[2];
    if (/^".*"$/.test(value)) { try { value = String(JSON.parse(value)); } catch { value = value.slice(1, -1); } }
    fields[found[1]] = value;
  }
  return fields;
}

export interface AcceptCrew { run(id: string): RunInfo | undefined; pending(): Proposal[] }
export interface AcceptDeps { crew: AcceptCrew; commitmentsDir: string; git?: GitRunner; ship?: ShipRunner }
const FINISHED = new Set(['completed', 'failed', 'stopped']);
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

/** The progress line a PR's state writes on the commitments linked to its run. */
const progressOf = (number: string, status: string, reason: string | undefined) =>
  status === 'merged' ? `PR #${number} mesclado` : status === 'queued' ? `PR #${number} aberto, auto-merge` : `PR #${number} aberto, sem auto-merge${reason ? ` (${reason})` : ''}`;

/** Links the PR to every open commitment whose links.runs holds the run; returns what it did, one note each. */
function linkCommitments(dir: string, runId: string, ref: string | undefined, progress: string) {
  const touched: string[] = [], failed: string[] = [];
  for (const item of readCommitments(dir)) {
    if (closed(item.status) || !item.links?.runs?.includes(runId)) continue;
    try {
      updateCommitment(dir, { id: item.id, progress, ...ref ? { links: { prs: [...item.links.prs ?? [], ref] } } : {} });
      touched.push(item.id);
    } catch (error) { failed.push(`${item.id} (${oneLine(error instanceof Error ? error.message : String(error), 80)})`); }
  }
  return { touched, failed };
}

/** Accepts a finished worker's committed branch in one call: refuses a dirty tree or no commits ahead, ships it (push, PR, auto-merge queue)
 * through scripts/ship.mjs, links the PR to the commitments tied to the run and returns the PR, the auto-merge state and the run's memory proposals.
 * ship's exit 4 (uncertain effect) is returned as it is and never retried. */
export async function acceptRun(deps: AcceptDeps, input: { runId: string; title: string; body: string }) {
  const { runId, title, body } = input, git = deps.git ?? runGit, ship = deps.ship ?? runShip;
  if (!title.trim() || !body.trim()) throw new Error('accept needs title (the PR title) and text (the PR description: problem, change, pending, evidence). Nothing was shipped.');
  const run = deps.crew.run(runId);
  if (!run) throw new Error(`No worker run ${runId}. Nothing was shipped.`);
  if (!run.kind || run.kind === 'plan') throw new Error(`Run ${runId} is not a code worker (a plan scout changes nothing). Nothing was shipped.`);
  if (!FINISHED.has(run.state)) throw new Error(`Run ${runId} is ${run.state}: accept it once it has reported. Nothing was shipped.`);
  const state = await branchState(run.cwd, git);
  if (!state) throw new Error(`Run ${runId}: ${run.cwd} is not a git checkout (gone?). Nothing was shipped.`);
  if (state.dirty.length) throw new Error(`Run ${runId}: dirty tree in ${run.cwd} (${state.dirty.length} uncommitted: ${state.dirty.slice(0, 5).map(line => line.trim()).join(', ')}). Have the worker commit or discard them. Nothing was shipped.`);
  if (state.branch.startsWith('(')) throw new Error(`Run ${runId}: ${run.cwd} is on a detached HEAD. Nothing was shipped.`);
  if (!state.base) throw new Error(`Run ${runId}: no origin/main to compare ${state.branch} with. Nothing was shipped.`);
  if (state.ahead === 0) throw new Error(`Run ${runId}: ${state.branch} has no commits ahead of ${state.base}. Nothing was shipped.`);

  const shipped = await ship(run.cwd, ['--title', title, '-b', body]);
  const fields = parseShip(shipped.out), status = fields.status ?? (shipped.code === null ? 'uncertain' : 'failed');
  const head = `Run ${runId}, ${state.branch}, ${state.ahead} commit${state.ahead === 1 ? '' : 's'} ahead of ${state.base}`;
  if (shipped.code === null || shipped.code === 4 || status === 'uncertain') {
    return `${head}: ship is UNCERTAIN (${fields.stage ?? 'killed or unreadable'}). Do not repeat accept. ${fields.next ?? 'Reconcile with gh pr view for the branch.'} Commitments were not touched.`;
  }
  if (shipped.code !== 0 && shipped.code !== 3) {
    const why = fields.error ?? fields.detail, advice = fields.hint ?? fields.next;
    throw new Error(`${head}: ship ${status} (exit ${shipped.code})${why ? `: ${why}` : ''}${advice ? `. ${advice}` : ''}`);
  }
  const url = fields.url, found = url ? PR_URL.exec(url) : null, number = fields.pr ?? found?.[2];
  const ref = found && number ? `${found[1]}#${number}` : undefined;
  const progress = progressOf(number ?? '?', status, fields.reason);
  let linked = 'no open commitment is linked to this run';
  try {
    const { touched, failed } = linkCommitments(deps.commitmentsDir, runId, ref, progress);
    if (touched.length || failed.length) linked = `${touched.length ? `${touched.join(', ')} got ${ref ?? 'the progress line'} and "${progress}"` : ''}${failed.length ? `${touched.length ? '; ' : ''}not updated: ${failed.join(', ')}` : ''}`;
  } catch (error) { linked = `commitments unreadable: ${oneLine(error instanceof Error ? error.message : String(error), 120)}`; }
  const proposals = deps.crew.pending().filter(p => p.runId === runId);
  return [
    `${head}: ${status}`,
    `PR: ${url ?? `#${number ?? '?'} (url not reported)`}`,
    `auto-merge: ${fields.auto_merge ?? status}${fields.reason ? ` (${fields.reason})` : ''}${fields.checks ? `; checks ${fields.checks}` : ''}`,
    ...status === 'not_queued' && fields.next ? [`next: ${fields.next}`] : [],
    `commitments: ${linked}`,
    proposals.length ? `Memory proposals of this run (apply the true lines with crew write, part memory):\n${proposals.map(p => `[${p.specialist}] ${p.text}`).join('\n\n')}` : 'Memory proposals of this run: none pending.',
  ].join('\n');
}
