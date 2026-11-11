import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptRun, parseShip, reportAppendix, runShip, workCheckout, worktreeOf, type GitRunner, type ShipRunner } from '../src/crew-accept.ts';
import { addCommitment, readCommitments, updateCommitment } from '../src/commitments.ts';
import { Crew, crewTool } from '../src/crew.ts';
import type { RunInfo } from '../src/runs.ts';
import { tempDir } from './support.ts';

const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@test.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@test.invalid' };
function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
/** A clone of a bare origin on branch feat/x, with `commits` commits ahead of origin/main. */
function repo(commits: number) {
  const { dir, close } = tempDir('accept-');
  const seed = join(dir, 'seed'), origin = join(dir, 'origin.git'), work = join(dir, 'work');
  git(dir, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'seed']);
  git(dir, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(seed, ['push', '-q', origin, 'main']);
  git(dir, ['clone', '-q', origin, work]);
  git(work, ['switch', '-q', '-c', 'feat/x']);
  for (let i = 1; i <= commits; i++) { writeFileSync(join(work, `f${i}.txt`), `${'line\n'.repeat(i)}`); git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', `feat: change ${i}`]); }
  return { dir, work, close };
}

test('the report appendix names the branch, the commits ahead of origin/main, the stat and the files', async t => {
  const fx = repo(2); t.after(fx.close);
  const text = await reportAppendix(fx.work);
  assert.match(text, /^\[git\] branch feat\/x: 2 commits ahead of origin\/main$/m);
  assert.match(text, /^ {2}[0-9a-f]{7,} feat: change 2$/m);
  assert.match(text, /^ {2}[0-9a-f]{7,} feat: change 1$/m);
  assert.match(text, /^ ?2 files changed, 3 insertions\(\+\)$/m, 'the stat summary line');
  assert.match(text, /^ f1\.txt +\| +1 \+$/m);
  assert.match(text, /^ f2\.txt +\| +2 \+\+$/m);
  assert.doesNotMatch(text, /dirty/);
});

test('the appendix warns about a dirty tree, caps long lists, and is empty off git', async t => {
  const fx = repo(1); t.after(fx.close);
  writeFileSync(join(fx.work, 'loose.txt'), 'x\n');
  writeFileSync(join(fx.work, 'f1.txt'), 'changed\n');
  assert.match(await reportAppendix(fx.work), /^⚠ dirty tree: 2 uncommitted files \(/m);
  for (let i = 0; i < 20; i++) { writeFileSync(join(fx.work, `many${i}.txt`), 'x\n'); }
  git(fx.work, ['add', '-A']); git(fx.work, ['commit', '-q', '-m', 'many']);
  const big = await reportAppendix(fx.work);
  assert.match(big, /… \d+ more files/);
  assert.ok(big.split('\n').length < 30, 'bounded');
  const plain = tempDir('nogit-'); t.after(plain.close);
  assert.equal(await reportAppendix(plain.dir), '');
  assert.equal(await reportAppendix(join(plain.dir, 'gone')), '');
});

test('the appendix never throws: a git failure becomes one line saying why', async () => {
  const broken: GitRunner = async (_cwd, args) => { if (args[0] === 'log') throw new Error('git log timed out'); return { code: 0, out: args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree' ? 'true\n' : args[0] === 'status' ? '' : 'x\n' }; };
  const cwd = process.cwd();
  const text = await reportAppendix(cwd, broken);
  assert.equal(text, '[git] appendix unavailable: git log timed out');
  const failing: GitRunner = async (_cwd, args) => ({ code: args[0] === 'status' ? 1 : 0, out: '' });
  assert.match(await reportAppendix(cwd, failing), /^\[git\] appendix unavailable: git status failed \(exit 1\)$/);
});

test('parseShip reads the flat output, unquoting URLs', () => {
  assert.deepEqual(parseShip('status: queued\nurl: "https://github.com/acme/app/pull/3"\npr: 3\nrc: 0\n'), { status: 'queued', url: 'https://github.com/acme/app/pull/3', pr: '3', rc: '0' });
});

function acceptFixture(options: { commits?: number; ship?: ShipRunner; kind?: string; state?: RunInfo['state'] } = {}) {
  const fx = repo(options.commits ?? 2);
  const crewDir = join(fx.dir, 'crew'), commitments = join(fx.dir, 'prof');
  mkdirSync(commitments, { recursive: true });
  const crew = new Crew(crewDir);
  const run: RunInfo = { id: 'run-1', task: 'x', cwd: fx.work, model: 'm', thinking: 'high', parentSession: 'p', started: 1, depth: 0, state: options.state ?? 'completed', kind: options.kind ?? 'code', project: 'harness', guidance: [] };
  crew.bindRuns(() => [run]);
  const calls: { cwd: string; args: string[] }[] = [];
  const ship: ShipRunner = options.ship ?? (async () => ({ code: 0, out: 'status: queued\nbranch: feat/x\npr: 7\nurl: "https://github.com/acme/app/pull/7"\nauto_merge: queued\nrc: 0\n', err: '' }));
  const wrapped: ShipRunner = async (cwd, args) => { calls.push({ cwd, args }); return ship(cwd, args); };
  const deps = { crew, commitmentsDir: commitments, ship: wrapped };
  return { ...fx, crew, run, deps, calls, commitments, close: async () => { await crew.closeAll(); fx.close(); } };
}

test('accept ships the clean branch once, links the PR to the commitments of the run and returns its memory proposals', async t => {
  const fx = acceptFixture(); t.after(fx.close);
  const linked = addCommitment(fx.commitments, { text: 'Entregar o worker', source: 's', links: { runs: ['run-1'] } });
  const other = addCommitment(fx.commitments, { text: 'Outro', source: 's', links: { runs: ['run-2'] } });
  const done = addCommitment(fx.commitments, { text: 'Feito', source: 's', links: { runs: ['run-1'] } });
  updateCommitment(fx.commitments, { id: done.id, status: 'done', evidence: 'ok' });
  fx.crew.propose('harness', 'run-1', '- LINHA_DA_MEMORIA');
  const text = (await crewTool(() => fx.crew, () => ({ commitmentsDir: fx.commitments, ship: fx.deps.ship })).execute('id', { action: 'accept', run: 'run-1', title: 'feat: dois commits', text: 'Problema, mudança, evidência.' })).content[0].text;
  assert.equal(fx.calls.length, 1, 'ship ran once');
  assert.equal(fx.calls[0]!.cwd, fx.work);
  assert.deepEqual(fx.calls[0]!.args, ['--title', 'feat: dois commits', '-b', 'Problema, mudança, evidência.']);
  assert.match(text, /PR: https:\/\/github\.com\/acme\/app\/pull\/7/);
  assert.match(text, /auto-merge: queued/);
  assert.match(text, new RegExp(`commitments: ${linked.id} got acme/app#7`));
  assert.match(text, /LINHA_DA_MEMORIA/);
  const items = readCommitments(fx.commitments);
  const touched = items.find(c => c.id === linked.id)!;
  assert.deepEqual(touched.links?.prs, ['acme/app#7']);
  assert.equal(touched.notes.at(-1)?.text, 'PR #7 aberto, auto-merge');
  assert.equal(items.find(c => c.id === other.id)!.links?.prs, undefined, 'another run\'s commitment is left alone');
  assert.equal(items.find(c => c.id === done.id)!.links?.prs, undefined, 'a closed commitment is left alone');
  assert.equal(items.find(c => c.id === linked.id)!.status, 'open', 'never closes it');
});

test('accept refuses, with nothing shipped, a dirty tree, no commits ahead, a plan scout, an unfinished run and a missing title', async t => {
  const dirty = acceptFixture(); t.after(dirty.close);
  writeFileSync(join(dirty.work, 'loose.txt'), 'x\n');
  await assert.rejects(acceptRun(dirty.deps, { runId: 'run-1', title: 't', body: 'b' }), /dirty tree.*loose\.txt.*Nothing was shipped/);
  const none = acceptFixture({ commits: 0 }); t.after(none.close);
  await assert.rejects(acceptRun(none.deps, { runId: 'run-1', title: 't', body: 'b' }), /no commits ahead of origin\/main/);
  const plan = acceptFixture({ kind: 'plan' }); t.after(plan.close);
  await assert.rejects(acceptRun(plan.deps, { runId: 'run-1', title: 't', body: 'b' }), /not a code worker/);
  const running = acceptFixture({ state: 'running' }); t.after(running.close);
  await assert.rejects(acceptRun(running.deps, { runId: 'run-1', title: 't', body: 'b' }), /is running/);
  await assert.rejects(acceptRun(running.deps, { runId: 'nope', title: 't', body: 'b' }), /No worker run nope/);
  const ok = acceptFixture(); t.after(ok.close);
  await assert.rejects(acceptRun(ok.deps, { runId: 'run-1', title: '', body: 'b' }), /needs title/);
  await assert.rejects(acceptRun(ok.deps, { runId: 'run-1', title: 't', body: ' ' }), /needs title/);
  for (const fx of [dirty, none, plan, running, ok]) assert.equal(fx.calls.length, 0, 'ship never ran');
});

test('accept hands exit 4 back as uncertain: no retry, no commitment touched', async t => {
  const fx = acceptFixture({ ship: async () => ({ code: 4, out: 'status: uncertain\nstage: push\nnext: git ls-remote origin refs/heads/feat/x para reconciliar\nrc: 4\n', err: '' }) }); t.after(fx.close);
  const item = addCommitment(fx.commitments, { text: 'Entregar', source: 's', links: { runs: ['run-1'] } });
  const text = await acceptRun(fx.deps, { runId: 'run-1', title: 't', body: 'b' });
  assert.match(text, /UNCERTAIN \(push\)\. Do not repeat accept\./);
  assert.match(text, /ls-remote/);
  assert.equal(fx.calls.length, 1, 'ship ran once and was not retried');
  assert.equal(readCommitments(fx.commitments).find(c => c.id === item.id)!.links?.prs, undefined);
  const killed = acceptFixture({ ship: async () => ({ code: null, out: '', err: 'timeout' }) }); t.after(killed.close);
  assert.match(await acceptRun(killed.deps, { runId: 'run-1', title: 't', body: 'b' }), /UNCERTAIN/);
});

test('accept reports a refused or failed ship as an error and a not_queued PR as opened without auto-merge', async t => {
  const refused = acceptFixture({ ship: async () => ({ code: 2, out: 'status: refused\nerror: unsafe_argument\nrc: 2\n', err: '' }) }); t.after(refused.close);
  await assert.rejects(acceptRun(refused.deps, { runId: 'run-1', title: 't', body: 'b' }), /ship refused \(exit 2\): unsafe_argument/);
  const manual = acceptFixture({ ship: async () => ({ code: 3, out: 'status: not_queued\npr: 9\nurl: "https://github.com/acme/app/pull/9"\nreason: sem check obrigatório\nnext: gh pr merge 9 --squash\nrc: 3\n', err: '' }) }); t.after(manual.close);
  const item = addCommitment(manual.commitments, { text: 'Entregar', source: 's', links: { runs: ['run-1'] } });
  const text = await acceptRun(manual.deps, { runId: 'run-1', title: 't', body: 'b' });
  assert.match(text, /auto-merge: not_queued \(sem check obrigatório\)/);
  assert.match(text, /next: gh pr merge 9/);
  assert.equal(readCommitments(manual.commitments).find(c => c.id === item.id)!.notes.at(-1)?.text, 'PR #9 aberto, sem auto-merge (sem check obrigatório)');
});

test('accept runs the real ship.mjs as a child process (no fakes) and reports what it printed', async t => {
  const fx = acceptFixture(); t.after(fx.close);
  const r = await runShip(fx.work, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /--title/);
});

/** A main checkout on main, clean, and a worktree `.worktrees/job` of it on fix/job with `commits` commits ahead of origin/main. */
function worktreeRepo(commits: number) {
  const { dir, close } = tempDir('accept-wt-');
  const seed = join(dir, 'seed'), origin = join(dir, 'origin.git'), main = join(dir, 'main');
  git(dir, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'seed']);
  git(dir, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(seed, ['push', '-q', origin, 'main']);
  git(dir, ['clone', '-q', origin, main]);
  appendFileSync(join(main, '.git', 'info', 'exclude'), '.worktrees/\n');
  const work = join(main, '.worktrees', 'job');
  git(main, ['worktree', 'add', '-q', '-b', 'fix/job', work, 'origin/main']);
  for (let i = 1; i <= commits; i++) { writeFileSync(join(work, `f${i}.txt`), 'line\n'); git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', `fix: change ${i}`]); }
  return { dir, main, work, close };
}
function worktreeFixture(commits = 2, worktrees?: (fx: { main: string; work: string }) => string[]) {
  const fx = worktreeRepo(commits);
  const commitmentsDir = join(fx.dir, 'prof'); mkdirSync(commitmentsDir, { recursive: true });
  const crew = new Crew(join(fx.dir, 'crew'));
  const run: RunInfo = { id: 'run-1', task: 'x', cwd: fx.main, model: 'm', thinking: 'high', parentSession: 'p', started: 1, depth: 0, state: 'completed', kind: 'code', project: 'harness', guidance: [], worktrees: (worktrees ?? (f => [f.work]))(fx) };
  crew.bindRuns(() => [run]);
  const calls: { cwd: string; args: string[] }[] = [];
  const ship: ShipRunner = async (cwd, args) => { calls.push({ cwd, args }); return { code: 0, out: 'status: queued\npr: 7\nurl: "https://github.com/acme/app/pull/7"\nauto_merge: queued\nrc: 0\n', err: '' }; };
  return { ...fx, run, calls, deps: { crew, commitmentsDir, ship }, close: async () => { await crew.closeAll(); fx.close(); } };
}

test('accept ships the worktree the run worked in, not its project checkout on main', async t => {
  const fx = worktreeFixture(); t.after(fx.close);
  const text = await acceptRun(fx.deps, { runId: 'run-1', title: 't', body: 'b' });
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.calls[0]!.cwd, fx.work, 'ship ran inside the run\'s worktree');
  assert.match(text, /^Run run-1, fix\/job, 2 commits ahead of origin\/main: queued/);
});

test('untracked or dirty files in the project checkout do not block a run that worked in a worktree; a dirty worktree still does', async t => {
  const fx = worktreeFixture(); t.after(fx.close);
  mkdirSync(join(fx.main, '.scratch')); writeFileSync(join(fx.main, '.scratch', 'note.txt'), 'x\n');
  writeFileSync(join(fx.main, 'README.md'), 'edited by someone else\n');
  assert.match(await acceptRun(fx.deps, { runId: 'run-1', title: 't', body: 'b' }), /: queued/);
  writeFileSync(join(fx.work, 'loose.txt'), 'x\n');
  await assert.rejects(acceptRun(fx.deps, { runId: 'run-1', title: 't', body: 'b' }), /dirty tree in .*job.*loose\.txt.*Nothing was shipped/);
  assert.equal(fx.calls.length, 1, 'the dirty worktree shipped nothing');
});

test('a run whose recorded worktree holds nothing falls back to its own directory, and a worktree of another repository is ignored', async t => {
  const empty = worktreeFixture(0); t.after(empty.close);
  await assert.rejects(acceptRun(empty.deps, { runId: 'run-1', title: 't', body: 'b' }), /main has no commits ahead of origin\/main/);
  const other = repo(2); t.after(other.close);
  const foreign = worktreeFixture(0, () => [other.work]); t.after(foreign.close);
  await assert.rejects(acceptRun(foreign.deps, { runId: 'run-1', title: 't', body: 'b' }), /main has no commits ahead/, 'an unrelated repository is never shipped for this run');
  assert.equal(foreign.calls.length, 0);
});

test('the report appendix of a run that worked in a worktree names that worktree\'s branch', async t => {
  const fx = worktreeFixture(); t.after(fx.close);
  const dir = await workCheckout(fx.run);
  assert.equal(dir, fx.work);
  assert.match(await reportAppendix(dir), /^\[git\] branch fix\/job: 2 commits ahead of origin\/main$/m);
  assert.equal(await workCheckout({ cwd: fx.main }), fx.main, 'no recorded worktree: the run\'s own directory');
});

test('worktreeOf finds the checkout a tool call works in when it is not the run\'s own: edit and write paths, cd and git -C targets', async t => {
  const fx = worktreeRepo(0); t.after(fx.close);
  const rel = '.worktrees/job';
  const found = (tool: string, args: unknown) => worktreeOf(tool, args, fx.main);
  const want = fx.work.replaceAll('\\', '/');
  assert.equal(found('edit', { path: join(fx.work, 'src', 'a.ts'), edits: [] }), want);
  assert.equal(found('write', { path: `${rel}/new.txt`, content: 'x' }), want, 'a relative path resolves against the run\'s directory');
  assert.equal(found('bash', { command: `cd ${rel} && npm test` }), want);
  assert.equal(found('bash', { command: `git -C "${fx.work}" commit -m x` }), want);
  assert.equal(found('powershell', { command: `Set-Location -LiteralPath '${fx.work}'; git status` }), want);
  assert.equal(found('bash', { command: `cd ${rel} && git status && cd ..` }), want, 'a later cd back out does not matter: the worktree was worked in');
  assert.equal(found('edit', { path: join(fx.main, 'src', 'a.ts') }), undefined, 'the run\'s own checkout is not a worktree');
  assert.equal(found('read', { path: join(fx.work, 'a.ts') }), undefined, 'reading is not working there');
  assert.equal(found('bash', { command: `cat ${rel}/README.md` }), undefined, 'neither is reading through the shell');
  assert.equal(found('bash', { command: 'ls' }), undefined);
  assert.equal(found('edit', { path: 5 }), undefined);
  assert.equal(found('bash', undefined), undefined);
});
