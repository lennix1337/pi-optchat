import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendExecLog, classify, EXEC_LOG, logBackgroundFailure, registerExecLog } from '../src/exec-log.ts';

const lines = (dir: string) => readFileSync(join(dir, EXEC_LOG), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('classifies outcomes in plain categories', () => {
  assert.equal(classify(false, 'all good'), 'ok');
  assert.equal(classify(true, 'Command exited with code 2'), 'exit_nonzero');
  assert.equal(classify(true, 'Command timed out after 60 seconds'), 'timeout');
  assert.equal(classify(true, 'Not executed: external outcome uncertain'), 'refused');
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

test('a background failure keeps the program stderr, not only the truncated command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'execlog-'));
  logBackgroundFailure(dir, 'PR watch', Object.assign(new Error('Command failed: gh api graphql -f query=...'), { code: 1, stderr: 'HTTP 502: Bad Gateway' }));
  const [entry] = lines(dir);
  assert.equal(entry.source, 'background');
  assert.equal(entry.class, 'exit_nonzero');
  assert.match(entry.detail, /HTTP 502/);
});
