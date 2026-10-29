import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ownedWindowsPids, reapingBashOperations, registerReapingBash } from '../src/shell-reaper.ts';

// Layout observed on 2026-10-29 for `cat /dev/zero | grep -c x | head -1` under Git Bash: the Git
// wrapper (24100) starts /usr/bin/bash (32472, MSYS pid 783). Each pipeline stage was forked and then
// exec'd, so its Windows parent (40748, 25816, 3596) is already gone and `taskkill /T` cannot reach it.
// Only MSYS knows the stages belong to bash 783. 779/781 are another session's shell.
const windows = new Map([[24100, 26952], [32472, 24100], [17256, 40748], [16788, 25816], [2712, 3596], [21944, 36480], [37616, 1]]);
const msys = [
  { pid: 783, ppid: 1, pgid: 783, winpid: 32472 },
  { pid: 784, ppid: 783, pgid: 783, winpid: 17256 },
  { pid: 785, ppid: 783, pgid: 783, winpid: 16788 },
  { pid: 786, ppid: 783, pgid: 783, winpid: 2712 },
  { pid: 779, ppid: 1, pgid: 779, winpid: 21944 },
  { pid: 781, ppid: 779, pgid: 779, winpid: 37616 },
];

test('a killed shell owns the pipeline stages whose Windows parents are gone', () => {
  assert.deepEqual([...ownedWindowsPids(24100, windows, msys)].sort((a, b) => a - b), [2712, 16788, 17256, 24100, 32472]);
});

test('a shell that joined an outer MSYS group does not take that whole group with it', () => {
  // Started from an MSYS parent (500, not ours): bash 783 keeps group 500. Its own children still go; 501 stays.
  const nested = [{ pid: 500, ppid: 1, pgid: 500, winpid: 9000 }, { pid: 501, ppid: 500, pgid: 500, winpid: 9001 },
    { pid: 783, ppid: 500, pgid: 500, winpid: 32472 }, { pid: 784, ppid: 783, pgid: 500, winpid: 17256 }];
  assert.deepEqual([...ownedWindowsPids(24100, windows, nested)].sort((a, b) => a - b), [17256, 24100, 32472]);
});

const MARKER = `reaperprobe${process.pid}`;
const survivors = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${MARKER}*' -and $_.Name -notin 'powershell.exe','node.exe' } | ForEach-Object { $_.ProcessId }`],
{ encoding: 'utf8', windowsHide: true }).split(/\s+/).filter(Boolean);

test('a timed-out Git Bash pipeline leaves no process behind', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  try {
    await assert.rejects(reapingBashOperations().exec(`cat /dev/zero | grep -c ${MARKER} | head -1`, process.cwd(), { onData: () => {}, timeout: 1 }), /timeout:1/);
    assert.deepEqual(survivors(), []);
  } finally {
    const left = survivors();
    if (left.length) execFileSync('taskkill.exe', ['/F', ...left.flatMap(pid => ['/PID', pid])], { stdio: 'ignore' });
  }
});

test('the bash tool and ! commands Pi runs use the reaping kill', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const tools = new Map<string, any>(), events = new Map<string, any>();
  registerReapingBash({ registerTool: (tool: any) => tools.set(tool.name, tool), on: (name: string, handler: any) => events.set(name, handler) } as unknown as ExtensionAPI);
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'session', getSessionFile: () => undefined } } as any;
  try {
    const result = await tools.get('bash').execute('call-1', { command: `cat /dev/zero | grep -c ${MARKER} | head -1`, timeout: 1 }, undefined, undefined, ctx).catch((error: Error) => error);
    assert.match(String((result as Error).message ?? JSON.stringify(result)), /timed out/i);
    assert.deepEqual(survivors(), []);
    const { operations } = events.get('user_bash')({}, ctx);
    await assert.rejects(operations.exec(`cat /dev/zero | grep -c ${MARKER} | head -1`, process.cwd(), { onData: () => {}, timeout: 1 }), /timeout:1/);
    assert.deepEqual(survivors(), []);
  } finally {
    const left = survivors();
    if (left.length) execFileSync('taskkill.exe', ['/F', ...left.flatMap(pid => ['/PID', pid])], { stdio: 'ignore' });
  }
});

test('a pipeline that ends by itself returns its output and exit code', { skip: process.platform !== 'win32' }, async () => {
  let output = '';
  const result = await reapingBashOperations().exec('printf "a\\nb\\n" | wc -l; exit 3', process.cwd(), { onData: data => { output += data.toString(); } });
  assert.equal(output.trim(), '2');
  assert.equal(result.exitCode, 3);
});
