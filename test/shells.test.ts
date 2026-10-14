import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShellJobs, registerShells } from '../src/shells.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

test('foreground inventory streams bounded output, records failure and refuses individual stop', () => {
  const jobs = new ShellJobs(); let changes = 0;
  const unsubscribe = jobs.subscribe(() => changes++);
  jobs.begin('call', 'echo hello', '/project', 'foreground');
  jobs.update('call', 'x'.repeat(40_000));
  assert.match(jobs.list()[0].output, /^\[Earlier output omitted\]/);
  assert.ok(jobs.list()[0].output.length < 32_100);
  assert.equal(jobs.stop('call'), false);
  jobs.end('call', 'bad exit', true);
  assert.equal(jobs.list()[0].state, 'failed');
  assert.ok(jobs.list()[0].ended);
  jobs.end('call', 'duplicate', false);
  assert.equal(jobs.list()[0].output, 'bad exit');
  unsubscribe(); assert.ok(changes >= 4);
});

test('managed jobs return immediately, stop independently and close waits for cleanup', async () => {
  const jobs = new ShellJobs();
  const run = (command: string) => jobs.start(command, '/project', async (signal, update) => {
    update('started');
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    return { output: 'closed', failed: false };
  });
  const a = run('server A'), b = run('server B');
  await Promise.resolve();
  assert.equal(jobs.stop(a), true);
  assert.equal(jobs.stop(a), false);
  assert.equal(jobs.list().find(j => j.id === b)?.state, 'running');
  await jobs.close();
  assert.ok(jobs.list().every(j => j.state === 'stopped'));
  assert.ok(jobs.list().every(j => j.ended));
});

test('managed background captures successful and rejected execution without unhandled rejection', async () => {
  const jobs = new ShellJobs();
  jobs.start('ok', '.', async () => ({ output: 'done', failed: false }));
  jobs.start('bad', '.', async () => { throw new Error('failure'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.list().find(j => j.command === 'ok')?.state, 'completed');
  assert.equal(jobs.list().find(j => j.command === 'bad')?.state, 'failed');
  await jobs.close();
});

test('shell events include nested Code Mode calls and ignore non-shell tools', () => {
  const jobs = new ShellJobs(), events = new Map<string, (event: any, ctx?: any) => void>();
  registerShells({ on: (name: string, handler: any) => events.set(name, handler), registerTool() {} } as unknown as ExtensionAPI, jobs);
  events.get('tool_execution_start')?.({ toolName: 'bash', toolCallId: 'nested', parentToolCallId: 'code', args: { command: 'echo yes' } }, { cwd: '.' });
  events.get('tool_execution_update')?.({ toolName: 'bash', toolCallId: 'nested', partialResult: { content: [{ type: 'text', text: 'yes' }] } });
  events.get('tool_execution_end')?.({ toolName: 'bash', toolCallId: 'nested', result: { content: [{ type: 'text', text: 'yes' }] }, isError: false });
  events.get('tool_execution_start')?.({ toolName: 'read', toolCallId: 'read', args: {} }, { cwd: '.' });
  assert.equal(jobs.list().length, 1);
  assert.equal(jobs.list()[0].state, 'completed');
});

test('native background command streams output and cancellation terminates its shell process', { timeout: 15_000 }, async () => {
  const jobs = new ShellJobs(), tools = new Map<string, any>();
  registerShells({ on() {}, registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI, jobs);
  const started = await tools.get('shell_start').execute('start', { command: 'node -e "console.log(process.pid); setInterval(() => {}, 1000)"', timeout: 10 }, undefined, undefined, { cwd: process.cwd() });
  const id = started.details.id;
  try {
    const deadline = Date.now() + 5_000;
    while (!/^\d+/m.test(jobs.list()[0].output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const pid = Number(jobs.list()[0].output.match(/^\d+/m)?.[0]);
    assert.ok(pid > 0, 'real child streamed its PID');
    assert.equal(jobs.stop(id), true);
    await jobs.close();
    assert.equal(jobs.list()[0].state, 'stopped');
    assert.throws(() => process.kill(pid, 0), 'native cancellation must terminate the child, not only mark the UI stopped');
  } finally { await jobs.close(); }
});

test('retention bounds finished history without dropping active executions', () => {
  const jobs = new ShellJobs(); jobs.begin('active', 'server', '.', 'foreground');
  for (let i = 0; i < 70; i++) { jobs.begin(`job-${i}`, 'echo', '.', 'foreground'); jobs.end(`job-${i}`, 'done', false); }
  assert.equal(jobs.list().length, 51);
  assert.equal(jobs.list()[0].id, 'active');
  assert.ok(jobs.list().some(j => j.id === 'job-69'));
  assert.ok(!jobs.list().some(j => j.id === 'job-0'));
});
