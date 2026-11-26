import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ownedWindowsPids, reapingBashOperations, registerReapingBash } from '../src/shell-reaper.ts';

// external: Git Bash pipeline processes can lose their Windows parent; taskkill /T cannot reach those children.



const windows = new Map([[24100, 26952], [32472, 24100], [17256, 40748], [16788, 25816], [2712, 3596], [21944, 36480], [37616, 1]]);
const msys = [
  { pid: 783, ppid: 1, pgid: 783, winpid: 32472 },
  { pid: 784, ppid: 783, pgid: 783, winpid: 17256 },
  { pid: 785, ppid: 783, pgid: 783, winpid: 16788 },
  { pid: 786, ppid: 783, pgid: 783, winpid: 2712 },
  { pid: 779, ppid: 1, pgid: 779, winpid: 21944 },
  { pid: 781, ppid: 779, pgid: 779, winpid: 37616 },
];



const outside = 1;

test('a killed shell owns the pipeline stages whose Windows parents are gone', () => {
  assert.deepEqual([...ownedWindowsPids(24100, windows, msys, outside)].sort((a, b) => a - b), [2712, 16788, 17256, 24100, 32472]);
});

test('the reaper never kills its own process, even when it sits in the shell tree', () => {
  assert.deepEqual([...ownedWindowsPids(24100, windows, msys, 17256)].sort((a, b) => a - b), [2712, 16788, 24100, 32472]);
});

test('a shell that joined an outer MSYS group does not take that whole group with it', () => {

  const nested = [{ pid: 500, ppid: 1, pgid: 500, winpid: 9000 }, { pid: 501, ppid: 500, pgid: 500, winpid: 9001 },
    { pid: 783, ppid: 500, pgid: 500, winpid: 32472 }, { pid: 784, ppid: 783, pgid: 500, winpid: 17256 }];
  assert.deepEqual([...ownedWindowsPids(24100, windows, nested, outside)].sort((a, b) => a - b), [17256, 24100, 32472]);
});

test('abort during the cwd check never starts a Windows shell', { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
  let entered!: () => void, release!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const access = fs.access, spawn = childProcess.spawn;
  let spawned = 0;
  const accessMock = t.mock.method(fs, 'access', async (...args: Parameters<typeof fs.access>) => {
    entered(); await gate; return access(...args);
  });
  const spawnMock = t.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof spawn>) => {
    spawned++; return spawn(...args);
  }) as typeof spawn);
  syncBuiltinESMExports();
  try {
    const controller = new AbortController();
    const result = reapingBashOperations().exec('node -e "setInterval(() => {}, 1000)"', process.cwd(), { onData: () => {}, signal: controller.signal });
    await checking;
    controller.abort(); release();
    await assert.rejects(result, /aborted/);
    assert.equal(spawned, 0, 'cancellation before spawn must not create a shell');
  } finally {
    release(); accessMock.mock.restore(); spawnMock.mock.restore(); syncBuiltinESMExports();
  }
});

const MARKER = `reaperprobe${process.pid}`;
const survivors = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${MARKER}*' -and $_.Name -notin 'powershell.exe','node.exe' } | ForEach-Object { $_.ProcessId }`],
{ encoding: 'utf8', windowsHide: true }).split(/\s+/).filter(Boolean);

const describeSurvivors = (pids: string[]) => pids.length ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Get-CimInstance Win32_Process | Where-Object { @(${pids.join(',')}) -contains $_.ProcessId } | ForEach-Object { "$($_.ProcessId) $($_.Name) parent=$($_.ParentProcessId) created=$($_.CreationDate.ToString('HH:mm:ss.fff'))" }`],
{ encoding: 'utf8', windowsHide: true }).trim() : '';
const assertNoSurvivors = () => { const left = survivors(); assert.deepEqual(left, [], describeSurvivors(left)); };

test('a timed-out Git Bash pipeline leaves no process behind', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  try {
    await assert.rejects(reapingBashOperations().exec(`cat /dev/zero | grep -c ${MARKER} | head -1`, process.cwd(), { onData: () => {}, timeout: 1 }), /timeout:1/);
    assertNoSurvivors();
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
    assertNoSurvivors();
    const { operations } = events.get('user_bash')({}, ctx);
    await assert.rejects(operations.exec(`cat /dev/zero | grep -c ${MARKER} | head -1`, process.cwd(), { onData: () => {}, timeout: 1 }), /timeout:1/);
    assertNoSurvivors();
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
