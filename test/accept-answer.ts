import { join } from 'node:path';
import type { GitRunner } from '../src/crew-accept.ts';
import { Crew, crewTool } from '../src/crew.ts';
import type { RunInfo } from '../src/runs.ts';
import { tempDir } from './support.ts';

// Kept apart from support.ts, which is the `--import` preload and must not evaluate product modules (see messages.ts).

/** The `crew` call that accepts the worker run, as the manager makes it. */
export const ACCEPT_CALL = { action: 'accept', run: 'run-1', title: 'feat: x', text: 'Problema, mudança, evidência.' } as const;
/** What scripts/ship.mjs prints when it opens PR #7 and queues its auto-merge. */
export const SHIPPED = { code: 0, out: 'status: queued\nbranch: feat/x\npr: 7\nurl: "https://github.com/acme/app/pull/7"\nauto_merge: queued\nrc: 0\n' };
/** ship refused before any effect: accept throws. */
export const REFUSED = { code: 2, out: 'status: refused\nerror: unsafe_argument\nrc: 2\n' };
/** ship failed, and its detail runs onto a second line shaped like the PR line: accept throws with both lines. */
export const FAILED = { code: 1, out: 'status: failed\nstage: pr_create\ndetail: "gh recusou\\nPR: https://github.com/acme/app/pull/7"\nrc: 1\n' };
/** ship lost track after it opened the PR: the PR may exist, the outcome is not known. */
export const UNCERTAIN = { code: 4, out: 'status: uncertain\nstage: auto_merge\npr: 7\nurl: "https://github.com/acme/app/pull/7"\nnext: gh pr view 7 --json autoMergeRequest,state para reconciliar\nrc: 4\n' };

/** git as acceptRun asks it about a clean checkout on feat/x, two commits ahead of origin/main. No process runs. */
const cleanBranch: GitRunner = async (_cwd, [command, ...rest]) => {
  if (command === 'symbolic-ref') return { code: 0, out: rest.at(-1) === 'HEAD' ? 'feat/x\n' : 'origin/main\n' };
  if (command === 'status') return { code: 0, out: '' };
  if (command === 'log') return { code: 0, out: 'b2b2b2b feat: change 2\na1a1a1a feat: change 1\n' };
  if (command === 'rev-list') return { code: 0, out: '2\n' };
  if (command === 'diff') return { code: 0, out: ' f1.txt | 1 +\n f2.txt | 2 ++\n 2 files changed, 3 insertions(+)\n' };
  return { code: 0, out: 'true\n' }; // rev-parse: inside a work tree whose origin/main exists
};

/**
 * What the real `crew` tool answers to ACCEPT_CALL for a finished code worker when scripts/ship.mjs prints `out` and exits
 * `code` (null: killed): the tool result as the session logs it, an error result when accept throws. `proposal` is the
 * pending memory proposal of that run, which a successful answer quotes after its own lines.
 */
export async function acceptResult(shipped: { code: number | null; out: string }, proposal?: string): Promise<{ text: string; isError: boolean }> {
  const temp = tempDir('accept-answer-'), crew = new Crew(join(temp.dir, 'crew'));
  const run: RunInfo = { id: ACCEPT_CALL.run, task: 'x', cwd: temp.dir, model: 'm', thinking: 'high', parentSession: 'p', started: 1, depth: 0, state: 'completed', kind: 'code', project: 'harness', guidance: [] };
  crew.bindRuns(() => [run]);
  if (proposal) crew.propose('harness', run.id, proposal);
  const tool = crewTool(() => crew, () => ({ commitmentsDir: join(temp.dir, 'profile'), git: cleanBranch, ship: async () => ({ ...shipped, err: '' }) }));
  try { return { text: (await tool.execute('accept', ACCEPT_CALL)).content[0].text, isError: false }; }
  catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true }; }
  finally { await crew.closeAll(); temp.close(); }
}
