import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ShellJobs, longCommandMover } from '../src/shells.ts';
import { registerReapingBash } from '../src/shell-reaper.ts';
import { LONG_COMMAND_NOTE } from '../src/long-commands.ts';

const printed = `node -e "console.log('moved-ok')"`;
const slow = `node -e "setTimeout(() => console.log('slow-ok'), 1500)"`;
const waitEnded = async (jobs: ShellJobs) => {
  const deadline = Date.now() + 15_000;
  while (jobs.list()[0]?.ended === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
};
const recorder = (jobs: ShellJobs) => {
  const reports: string[] = [];
  jobs.setReporter({ finished: job => reports.push(`${job.state}: ${job.output.trim()}`), alerted() {} });
  return reports;
};
const text = (result: { content: { text?: string }[] }) => result.content.map(part => part.text ?? '').join('\n');

test('a long command still running after the grace returns its background shell ID, and its end reaches the reporter', { timeout: 20_000 }, async () => {
  const jobs = new ShellJobs(), reports = recorder(jobs);
  const moved = await longCommandMover(jobs, {}, () => {}, 200)({ command: slow, timeout: 121 }, process.cwd());
  assert.ok(moved, 'an explicit timeout above the limit is moved, not run here');
  assert.equal(jobs.list()[0].state, 'running', 'the call returned while the command was still running');
  const id = jobs.list()[0].id;
  assert.match(text(moved), new RegExp(`background shell ${id}`));
  assert.match(text(moved), /still running after 0\.2 s/);
  await waitEnded(jobs);
  assert.equal(jobs.list()[0].state, 'completed');
  assert.deepEqual(reports, ['completed: slow-ok']);
});

// moves.mjs over 14 days of sessions: 159 of 166 moved commands ended within 30 s (median 3.6 s), and each cost a
// "[shell ID]" message, polls or an ended turn to get a result a foreground call would have returned.
test('a long command that ends within the grace returns its output inline, and no end notice follows', { timeout: 20_000 }, async () => {
  const jobs = new ShellJobs(), reports = recorder(jobs);
  const result = await longCommandMover(jobs, {}, () => {}, 10_000)({ command: printed, timeout: 121 }, process.cwd());
  assert.ok(result);
  assert.match(text(result), /moved-ok/);
  assert.doesNotMatch(text(result), /background shell/);
  assert.notEqual(result.isError, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(reports, [], 'the result came back in the call, so no "[shell ID]" message repeats it');
  assert.equal(jobs.list()[0].state, 'completed');
});

test('a failing long command that ends within the grace is an error result with its exit code', { timeout: 20_000 }, async () => {
  const jobs = new ShellJobs(), reports = recorder(jobs);
  const result = await longCommandMover(jobs, {}, () => {}, 10_000)({ command: `node -e "console.log('bad'); process.exit(3)"`, timeout: 121 }, process.cwd());
  assert.ok(result);
  assert.equal(result.isError, true);
  assert.match(text(result), /bad/);
  assert.match(text(result), /exited with code 3/);
  assert.deepEqual(reports, []);
});

test('an aborted call stops the shell it started instead of leaving it running', { timeout: 20_000 }, async () => {
  const jobs = new ShellJobs(), reports = recorder(jobs), abort = new AbortController();
  const pending = longCommandMover(jobs, {}, () => {}, 10_000)({ command: `node -e "setTimeout(() => {}, 20000)"`, timeout: 121 }, process.cwd(), abort.signal);
  setTimeout(() => abort.abort(), 300);
  const result = await pending;
  assert.ok(result);
  assert.equal(result.isError, true);
  assert.equal(jobs.list()[0].state, 'stopped');
  assert.deepEqual(reports, []);
});

// 37 bash calls in 14 days were refused with "Not run: it sleeps N s" and 29 of them were retried as shell_start:
// the mover now does that step itself.
test('a foreground wait is moved like a long command instead of refused', { timeout: 20_000 }, async () => {
  const jobs = new ShellJobs(), reports = recorder(jobs);
  const command = `node -e "setTimeout(() => console.log('waited'), 1500)" ; sleep 16 2>/dev/null || true`;
  const moved = await longCommandMover(jobs, {}, () => {}, 200)({ command }, process.cwd());
  assert.ok(moved, 'a 16 s sleep is a wait, so it leaves the turn');
  assert.match(text(moved), /it sleeps 16 s/);
  assert.equal(jobs.list()[0].state, 'running');
  jobs.stop(jobs.list()[0].id);
  await waitEnded(jobs);
  assert.deepEqual(reports, ['stopped: ' + jobs.list()[0].output.trim()]);
});

test('a short command is not moved: no shell starts and the mover returns nothing', () => {
  const jobs = new ShellJobs();
  assert.equal(longCommandMover(jobs, {})({ command: 'echo short' }, process.cwd()), undefined);
  assert.equal(longCommandMover(jobs, {})({ command: 'sleep 2 && echo ready' }, process.cwd()), undefined, 'a readiness pause is not a wait');
  assert.equal(jobs.list().length, 0);
});

test('the bash tool moves a long call to a shell, runs a short one in place, and says so in its description', { timeout: 30_000 }, async () => {
  const jobs = new ShellJobs(), tools = new Map<string, any>();
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), on() {} } as unknown as ExtensionAPI;
  registerReapingBash(pi, longCommandMover(jobs, {}, () => {}, 200));
  const bash = tools.get('bash');
  assert.ok(bash, 'the bash tool is registered with the mover, on every platform');
  assert.ok(bash.description.includes(LONG_COMMAND_NOTE), 'the model reads that a long call returns a shell ID');
  const cwd = process.cwd(), ctx = { cwd, sessionManager: { getSessionId: () => 'test-session', getSessionFile: () => undefined } };
  const moved = await bash.execute('long', { command: slow, timeout: 121 }, undefined, undefined, ctx);
  assert.match(text(moved), /moved to background shell/);
  await waitEnded(jobs);
  const short = await bash.execute('short', { command: `node -e "console.log('short-ok')"` }, undefined, undefined, ctx);
  assert.match(text(short), /short-ok/);
  assert.equal(jobs.list().length, 1, 'only the long call started a managed shell');
});

test('through the bash tool, a long command that fails within the grace is an error result', { timeout: 30_000 }, async () => {
  const jobs = new ShellJobs(), tools = new Map<string, any>();
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), on() {} } as unknown as ExtensionAPI;
  registerReapingBash(pi, longCommandMover(jobs, {}, () => {}, 10_000));
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'test-session', getSessionFile: () => undefined } };
  const failed = await tools.get('bash').execute('fail', { command: `node -e "process.exit(4)"`, timeout: 121 }, undefined, undefined, ctx);
  assert.equal(failed.isError, true);
  assert.match(text(failed), /exited with code 4/);
});
