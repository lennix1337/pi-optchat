// Test double for `gh`, used only by test/ship.test.ts through a shim on PATH. It keeps pull requests in a JSON state
// file and appends every call to a log, so a test can check which effects ran. Only the `pr` verbs that ship uses exist.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\n');
if (state.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.delayMs); // measured latency per call
const save = () => writeFileSync(statePath, JSON.stringify(state));
const fail = (message, code = 1) => { process.stderr.write(message + '\n'); process.exit(code); };
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const find = ref => /^\d+$/.test(ref) ? state.prs.find(p => p.number === Number(ref)) : [...state.prs].reverse().find(p => p.headRefName === ref);

const headOf = pr => pr.headRefOid ?? spawnSync('git', ['rev-parse', '--verify', pr.headRefName ? `origin/${pr.headRefName}` : 'HEAD'], { encoding: 'utf8' }).stdout.trim();

const [group, verb, ...rest] = args;
const commitsOf = pr => pr.commits ?? [{ sha: headOf(pr), patch: pr.diff ?? '' }];
if (group === 'api') {
  const endpoint = args.find(arg => arg.startsWith('repos/acme/app/')) ?? '';
  const listing = /^repos\/acme\/app\/pulls\/(\d+)\/commits$/.exec(endpoint);
  const commit = /^repos\/acme\/app\/commits\/([a-f\d]{40})$/.exec(endpoint);
  if (listing && args.includes('--paginate') && args.includes('--slurp')) {
    const pr = find(listing[1]);
    if (pr) {
      const entries = commitsOf(pr).map(c => ({ sha: c.sha, commit: { message: c.message ?? 'fixture' } }));
      process.stdout.write(JSON.stringify([entries.slice(0, 1), entries.slice(1)]));
      process.exit(0);
    }
  }
  if (commit && args.includes('--header=Accept:application/vnd.github.diff')) {
    const entry = state.prs.flatMap(commitsOf).find(c => c.sha === commit[1]);
    if (entry) { process.stdout.write(entry.patch); process.exit(0); }
  }
  fail(`fake gh: unsupported ${args.join(' ')}`, 2);
}
if (group !== 'pr') fail(`fake gh: unsupported ${args.join(' ')}`, 2);

if (verb === 'view') {
  if (state.viewDrops > 0) { state.viewDrops -= 1; save(); fail('Post "https://api.github.com/graphql": dial tcp 4.228.31.149:443: connectex: A connection attempt failed'); } // dropped connection
  const pr = find(rest[0]);
  if (!pr) fail(`no pull requests found for branch "${rest[0]}"`);
  const fields = (flag('--json') ?? '').split(',').filter(Boolean);
  state.viewTimes = [...(state.viewTimes ?? []), Date.now()];
  if (state.settleAfterViews && state.viewTimes.length > state.settleAfterViews.count) Object.assign(pr, state.settleAfterViews.patch); // GitHub settles the PR (checks appear, BLOCKED) some views after it opens
  save();
  const snapshot = { baseRefName: 'main', ...pr, headRefOid: headOf(pr) };
  process.stdout.write(JSON.stringify(Object.fromEntries(fields.map(f => [f, snapshot[f] ?? null]))) + '\n');
} else if (verb === 'diff') {
  const pr = find(rest[0]);
  if (!pr) fail(`no pull requests found for ${rest[0]}`);
  process.stdout.write((rest.includes('--name-only') ? pr.names : pr.diff) ?? '');
} else if (verb === 'list') {
  process.stdout.write(JSON.stringify(state.prs.map(pr => ({ url: `https://github.com/acme/app/pull/${pr.number}`, ...pr, headRefOid: headOf(pr) }))));
} else if (verb === 'edit') {
  const pr = find(rest[0]);
  if (!pr) fail(`no pull requests found for ${rest[0]}`);
  const file = flag('--body-file');
  if (file) pr.body = readFileSync(file === '-' ? 0 : file, 'utf8');
  if (flag('--title') !== undefined) pr.title = flag('--title');
  if (state.afterEdit) Object.assign(pr, state.afterEdit);
  save();
} else if (verb === 'create') {
  if (state.createHangs) { sleepSync(3000); process.exit(0); }
  if (state.createFails) fail(state.createFails);
  const number = Math.max(0, ...state.prs.map(p => p.number)) + 1;
  const url = `https://github.com/acme/app/pull/${number}`;
  state.prs.push({ number, url, state: 'OPEN', headRefName: flag('--head'), baseRefName: flag('--base'), title: flag('--title') ?? null, mergeStateStatus: state.defaults.mergeStateStatus, autoMergeRequest: null, statusCheckRollup: state.defaults.checks, body: flag('--body-file') ? readFileSync(flag('--body-file'), 'utf8') : '' });
  save();
  process.stdout.write(url + '\n');
} else if (verb === 'merge') {
  const pr = find(rest[0]);
  if (!pr) fail(`no pull requests found for ${rest[0]}`);
  if (rest.includes('--disable-auto')) {
    pr.autoMergeRequest = null;
    save();
    process.exit(0);
  }
  if (flag('--match-head-commit') !== headOf(pr)) fail('head mismatch');
  if (!rest.includes('--auto')) {
    if (pr.mergeStateStatus !== 'CLEAN') fail(`Pull request is not mergeable: ${pr.mergeStateStatus}`);
    pr.state = 'MERGED';
    save();
    process.stdout.write(`✓ Squashed and merged pull request #${pr.number}
`);
    process.exit(0);
  }
  if (state.autoMerge === 'disabled') fail('Auto merge is not allowed for this repository');
  if (state.autoMerge === 'clean') fail('Pull request is in clean status');
  if (state.autoMerge === 'merge_now') pr.state = 'MERGED';
  pr.autoMergeRequest = { enabledAt: '2026-11-02T00:00:00Z', mergeMethod: 'SQUASH' };
  save();
  process.stdout.write(`✓ Pull request #${pr.number} will be automatically merged via squash when all requirements are met\n`);
} else {
  fail(`fake gh: unsupported pr ${verb}`, 2);
}
