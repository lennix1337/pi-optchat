import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ShellJobs, longCommandMover } from '../src/shells.ts';
import { registerReapingBash } from '../src/shell-reaper.ts';
import { LONG_COMMAND_NOTE } from '../src/long-commands.ts';

const printed = `node -e "console.log('moved-ok')"`;
const waitEnded = async (jobs: ShellJobs) => {
  const deadline = Date.now() + 15_000;
  while (jobs.list()[0]?.ended === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
};

test('a long command returns its background shell ID before it ends, and its end reaches the reporter', { timeout: 20_000 }, async () => {
  const jobs = new ShellJobs(), reports: string[] = [];
  jobs.setReporter({ finished: job => reports.push(`${job.state}: ${job.output.trim()}`), alerted() {} });
  const moved = longCommandMover(jobs, {})({ command: printed, timeout: 121 }, process.cwd());
  assert.ok(moved, 'an explicit timeout above the limit is moved, not run here');
  assert.equal(jobs.list()[0].state, 'running', 'the call returned while the command was still running');
  const id = jobs.list()[0].id;
  assert.match(moved.content[0].text, new RegExp(`background shell ${id}`));
  await waitEnded(jobs);
  assert.equal(jobs.list()[0].state, 'completed');
  assert.match(jobs.list()[0].output, /moved-ok/);
  assert.deepEqual(reports, ['completed: moved-ok']);
});

test('a short command is not moved: no shell starts and the mover returns nothing', () => {
  const jobs = new ShellJobs();
  assert.equal(longCommandMover(jobs, {})({ command: 'echo short' }, process.cwd()), undefined);
  assert.equal(jobs.list().length, 0);
});

test('the bash tool moves a long call to a shell, runs a short one in place, and says so in its description', { timeout: 30_000 }, async () => {
  const jobs = new ShellJobs(), tools = new Map<string, any>();
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), on() {} } as unknown as ExtensionAPI;
  registerReapingBash(pi, longCommandMover(jobs, {}));
  const bash = tools.get('bash');
  assert.ok(bash, 'the bash tool is registered with the mover, on every platform');
  assert.ok(bash.description.includes(LONG_COMMAND_NOTE), 'the model reads that a long call returns a shell ID');
  const cwd = process.cwd(), ctx = { cwd, sessionManager: { getSessionId: () => 'test-session', getSessionFile: () => undefined } };
  const moved = await bash.execute('long', { command: printed, timeout: 121 }, undefined, undefined, ctx);
  assert.match(moved.content[0].text, /Long command moved to background shell/);
  await waitEnded(jobs);
  const short = await bash.execute('short', { command: `node -e "console.log('short-ok')"` }, undefined, undefined, ctx);
  assert.match(short.content.map((part: { text?: string }) => part.text ?? '').join('\n'), /short-ok/);
  assert.equal(jobs.list().length, 1, 'only the long call started a managed shell');
});
