// Test double for `gh`, used only by test/ship.test.ts through a shim on PATH. It keeps pull requests in a JSON state
// file and appends every call to a log, so a test can check which effects ran. Only the `pr` verbs that ship uses exist.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

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

const [group, verb, ...rest] = args;
if (group !== 'pr') fail(`fake gh: unsupported ${args.join(' ')}`, 2);

if (verb === 'view') {
  const pr = find(rest[0]);
  if (!pr) fail(`no pull requests found for branch "${rest[0]}"`);
  const fields = (flag('--json') ?? '').split(',').filter(Boolean);
  state.viewTimes = [...(state.viewTimes ?? []), Date.now()];
  if (state.settleAfterViews && state.viewTimes.length > state.settleAfterViews.count) Object.assign(pr, state.settleAfterViews.patch); // GitHub settles the PR (checks appear, BLOCKED) some views after it opens
  save();
  process.stdout.write(JSON.stringify(Object.fromEntries(fields.map(f => [f, pr[f] ?? null]))) + '\n');
} else if (verb === 'create') {
  if (state.createHangs) { sleepSync(3000); process.exit(0); }
  if (state.createFails) fail(state.createFails);
  const number = Math.max(0, ...state.prs.map(p => p.number)) + 1;
  const url = `https://github.com/acme/app/pull/${number}`;
  state.prs.push({ number, url, state: 'OPEN', headRefName: flag('--head'), baseRefName: flag('--base'), mergeStateStatus: state.defaults.mergeStateStatus, autoMergeRequest: null, statusCheckRollup: state.defaults.checks, body: flag('--body-file') ? readFileSync(flag('--body-file'), 'utf8') : '' });
  save();
  process.stdout.write(url + '\n');
} else if (verb === 'merge') {
  const pr = find(rest[0]);
  if (!pr) fail(`no pull requests found for ${rest[0]}`);
  if (state.autoMerge === 'disabled') fail('Auto merge is not allowed for this repository');
  if (state.autoMerge === 'clean') fail('Pull request is in clean status');
  if (state.autoMerge === 'merge_now') pr.state = 'MERGED';
  pr.autoMergeRequest = { enabledAt: '2026-11-02T00:00:00Z', mergeMethod: 'SQUASH' };
  save();
  process.stdout.write(`✓ Pull request #${pr.number} will be automatically merged via squash when all requirements are met\n`);
} else {
  fail(`fake gh: unsupported pr ${verb}`, 2);
}
