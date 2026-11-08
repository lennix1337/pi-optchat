import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendExecLog, classify, EXEC_LOG, isNoMatch, isShipWait, logBackgroundFailure, registerExecLog } from '../src/exec-log.ts';

const lines = (dir: string) => readFileSync(join(dir, EXEC_LOG), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('classifies outcomes in plain categories', () => {
  assert.equal(classify(false, 'all good'), 'ok');
  assert.equal(classify(true, 'Command exited with code 2'), 'exit_nonzero');
  assert.equal(classify(true, 'Command timed out after 60 seconds'), 'timeout');
  assert.equal(classify(true, 'Not executed: external outcome uncertain'), 'refused');
  assert.equal(classify(true, 'Not run: bash expands $x inside the double quotes before PowerShell starts'), 'refused');
  assert.equal(classify(true, 'spawn gh ENOENT', 'ENOENT'), 'not_found');
  assert.equal(classify(true, 'gh: API rate limit exceeded'), 'rate_limited');
  assert.equal(classify(true, 'read ECONNRESET'), 'network');
  assert.equal(classify(true, 'weird'), 'error');
});

test('rotates to one .1 file instead of growing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'execlog-'));
  for (let i = 0; i < 40; i++) appendExecLog(dir, { at: 'x', source: 'tool', name: 'bash', class: 'ok', target: 'y'.repeat(50) }, 1000);
  assert.ok(existsSync(join(dir, `${EXEC_LOG}.1`)));
  assert.ok(readFileSync(join(dir, EXEC_LOG)).length <= 1000);
});

test('every tool call is logged with its class, and failures keep the reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'execlog-'));
  const handlers: Record<string, (e: any) => void> = {};
  registerExecLog({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any, () => dir);
  handlers.tool_execution_start({ toolCallId: '1', toolName: 'bash', args: { command: 'gh pr list' } });
  handlers.tool_execution_end({ toolCallId: '1', toolName: 'bash', isError: false, durationMs: 12.4, result: { content: [{ type: 'text', text: 'ok' }] } });
  handlers.tool_execution_start({ toolCallId: '2', toolName: 'bash', args: { command: 'false' } });
  handlers.tool_execution_end({ toolCallId: '2', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'boom\nCommand exited with code 1' }] } });
  const [a, b] = lines(dir);
  assert.deepEqual([a.class, a.target, a.ms, a.detail], ['ok', 'gh pr list', 12, undefined]);
  assert.deepEqual([b.class, b.code], ['exit_nonzero', 1]);
  assert.match(b.detail, /boom/);
});

test('words in a finished command output do not make it a timeout, network error or refusal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'execlog-'));
  const handlers: Record<string, (e: any) => void> = {};
  registerExecLog({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any, () => dir);
  const end = (id: string, isError: boolean, text: string) => {
    handlers.tool_execution_start({ toolCallId: id, toolName: 'bash', args: { command: id } });
    handlers.tool_execution_end({ toolCallId: id, toolName: 'bash', isError, durationMs: 5, result: { content: [{ type: 'text', text }] } });
  };
  end('grep hit', false, 'src/a.ts:3: const timeout = 30; // timed out, ECONNRESET, Not executed: x, SIGTERM');
  end('failing log', true, 'not ok 3 - handles timeout and socket hang up\nCommand exited with code 1');
  end('killed by timeout', true, 'partial\nCommand exited with code 124');
  end('real timeout', true, 'Command timed out after 60 seconds');
  assert.deepEqual(lines(dir).map(l => l.class), ['ok', 'exit_nonzero', 'timeout', 'timeout']);
});

test('a background failure keeps the program stderr, not only the truncated command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'execlog-'));
  logBackgroundFailure(dir, 'PR watch', Object.assign(new Error('Command failed: gh api graphql -f query=...'), { code: 1, stderr: 'HTTP 502: Bad Gateway' }));
  const [entry] = lines(dir);
  assert.equal(entry.source, 'background');
  assert.equal(entry.class, 'exit_nonzero');
  assert.match(entry.detail, /HTTP 502/);
});

test('an exit code quoted in another tool\'s output is not this call failing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'execlog-'));
  const handlers: Record<string, (e: any) => void> = {};
  registerExecLog({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any, () => dir);
  const call = (id: string, toolName: string, text: string, isError = false) => {
    handlers.tool_execution_start({ toolCallId: id, toolName, args: {} });
    handlers.tool_execution_end({ toolCallId: id, toolName, isError, result: { content: [{ type: 'text', text }] } });
  };
  call('1', 'shell_status', 'shell abc: finished\nbuild output\nCommand exited with code 1');
  call('2', 'bash', 'grep hit: "Command exited with code 1" in the log\nmore lines');
  call('3', 'bash', 'boom\nCommand exited with code 1');
  assert.deepEqual(lines(dir).map(l => l.class), ['ok', 'ok', 'exit_nonzero']);
});

test('grep or rg that finds nothing is an answer, not a failed call; any other exit 1 still is', () => {
  assert.equal(isNoMatch('grep -n foo src/a.ts', '(no output)\n\nCommand exited with code 1'), true);
  assert.equal(isNoMatch('cd repo && rg -l foo | head', '\n\nCommand exited with code 1'), false);
  assert.equal(isNoMatch('cd repo && rg -l foo', 'Command exited with code 1'), true);
  assert.equal(isNoMatch('grep foo missing.txt', 'grep: missing.txt: No such file or directory\n\nCommand exited with code 2'), false);
  assert.equal(isNoMatch('node test.mjs', '(no output)\n\nCommand exited with code 1'), false);
  assert.equal(isNoMatch('grep -c x f; echo $?', 'Command exited with code 1'), false);
  // After `;` or a pipe the exit code is the last command's, so output printed earlier does not hide a grep miss.
  assert.equal(isNoMatch('git status -sb | head; grep -n foo src/a.ts', '## main...origin/main\n\nCommand exited with code 1'), true);
  assert.equal(isNoMatch('ls src | grep -i pipe', 'Command exited with code 1'), true);
  // After `&&` or `||` the exit code may come from the earlier command, so only an empty output proves a miss.
  assert.equal(isNoMatch('make test && grep -n foo log', 'tests failed\n\nCommand exited with code 1'), false);
  assert.equal(isNoMatch('make test || grep -n foo log', 'tests failed\n\nCommand exited with code 1'), false);
  const dir = mkdtempSync(join(tmpdir(), 'execlog-'));
  const handlers: Record<string, (e: any) => void> = {};
  registerExecLog({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any, () => dir);
  const call = (id: string, command: string, text: string) => {
    handlers.tool_execution_start({ toolCallId: id, toolName: 'bash', args: { command } });
    handlers.tool_execution_end({ toolCallId: id, toolName: 'bash', isError: true, result: { content: [{ type: 'text', text }] } });
  };
  call('1', 'grep -n zzz src/a.ts', '(no output)\n\nCommand exited with code 1');
  call('2', 'grep -n zzz missing.ts', 'grep: missing.ts: No such file or directory\n\nCommand exited with code 2');
  call('3', 'node check.mjs', '(no output)\n\nCommand exited with code 1');
  assert.deepEqual(lines(dir).map(l => l.class), ['ok', 'exit_nonzero', 'exit_nonzero']);
});

test('separators inside quotes do not hide the final grep', () => {
  const miss = 'Command exited with code 1';
  assert.equal(isNoMatch('cd r; ls test | grep -i "assistant-server\\|http"', miss), true);
  assert.equal(isNoMatch("cd r; ls test | grep 'a;b|c'", miss), true);
  assert.equal(isNoMatch('cd r && echo "x && y" && grep z f', 'x && y\n\n' + miss), false);
  assert.equal(isNoMatch('echo "a | grep b"', miss), false);
});

test('a long command is judged by its whole text, not by the clipped target kept in the log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'execlog-'));
  const handlers: Record<string, (e: any) => void> = {};
  registerExecLog({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any, () => dir);
  const call = (id: string, command: string, text: string) => {
    handlers.tool_execution_start({ toolCallId: id, toolName: 'bash', args: { command } });
    handlers.tool_execution_end({ toolCallId: id, toolName: 'bash', isError: true, result: { content: [{ type: 'text', text }] } });
  };
  const long = `cd /p && ${'echo step; '.repeat(30)}cat out.txt | grep -B2 needle | grep Path`;
  call('1', long, '---\n\nCommand exited with code 1');
  call('2', `${'echo step; '.repeat(30)}node check.mjs`, '---\n\nCommand exited with code 1');
  const opened = 'status: not_queued\nbranch: fix/x\npr: 7\nrc: 3\n\nCommand exited with code 3';
  call('3', `${'echo step; '.repeat(30)}node scripts/ship.mjs -m x --all`, opened);
  assert.ok(long.length > 200);
  assert.deepEqual(lines(dir).map(l => l.class), ['ok', 'exit_nonzero', 'ok']);
});

test('ship.mjs opening a PR whose checks are still pending is a normal wait, not a failed call; refusals still are', () => {
  const opened = 'status: not_queued\nbranch: fix/x\npr: 7\nchecks: 0 pass / 2 pending / 0 fail\nauto_merge: not_queued\nrc: 3\n\nCommand exited with code 3';
  assert.equal(isShipWait('node C:/projetos/pi-optchat/scripts/ship.mjs -m x --all', opened), true);
  assert.equal(isShipWait('node scripts/ship.mjs --all', 'status: refused\nerror: default_branch\nrc: 2\n\nCommand exited with code 2'), false);
  assert.equal(isShipWait('node scripts/ship.mjs --all', 'status: not_queued\nrc: 3'), false, 'no PR was opened');
  assert.equal(isShipWait('echo "status: not_queued pr: 7"', opened), false, 'only ship.mjs speaks for itself');
  const dir = mkdtempSync(join(tmpdir(), 'execlog-'));
  const handlers: Record<string, (e: any) => void> = {};
  registerExecLog({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any, () => dir);
  const call = (id: string, command: string, text: string) => {
    handlers.tool_execution_start({ toolCallId: id, toolName: 'bash', args: { command } });
    handlers.tool_execution_end({ toolCallId: id, toolName: 'bash', isError: true, result: { content: [{ type: 'text', text }] } });
  };
  call('1', 'node scripts/ship.mjs --all -b body', opened);
  call('2', 'node scripts/ship.mjs --all', 'status: refused\nerror: default_branch\nrc: 2\n\nCommand exited with code 2');
  assert.deepEqual(lines(dir).map(l => l.class), ['ok', 'exit_nonzero']);
});

test('a failure keeps the end of a long output, where the error and the exit code are', () => {
  const dir = mkdtempSync(join(tmpdir(), 'execlog-'));
  const handlers: Record<string, (e: any) => void> = {};
  registerExecLog({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any, () => dir);
  handlers.tool_execution_start({ toolCallId: 'l', toolName: 'bash', args: { command: 'dotnet test' } });
  handlers.tool_execution_end({ toolCallId: 'l', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: `${'passed line\n'.repeat(80)}Assert.Equal() Failure at Foo.cs:240\nCommand exited with code 2` }] } });
  const [row] = lines(dir);
  assert.match(row.detail, /Failure at Foo\.cs:240 Command exited with code 2$/);
  assert.ok(row.detail.length <= 300);
});
