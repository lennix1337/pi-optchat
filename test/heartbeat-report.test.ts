import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beatSnapshot, type WakeRecord } from '../src/heartbeat.ts';
import { heartbeatCommand, renderReport, summarizeTurn } from '../src/heartbeat-report.ts';
import { queueFile } from '../src/heartbeat-queue.ts';

const call = (id: string, name: string, args: unknown) => ({ type: 'toolCall', id, name, arguments: args });
const assistant = (content: unknown[], stopReason = 'stop', errorMessage?: string) => ({ role: 'assistant', content, stopReason, errorMessage });
const result = (toolCallId: string, toolName: string, text: string, isError = false) => ({ role: 'toolResult', toolCallId, toolName, isError, content: [{ type: 'text', text }] });

test('a turn is summarized by its last reply, its tool calls and the commits and pushes it made', () => {
  const summary = summarizeTurn([
    { role: 'user', content: '[OptChat heartbeat] ...' },
    assistant([{ type: 'text', text: 'Looking.' }, call('1', 'read', { path: 'a.ts' }), call('2', 'bash', { command: 'git add -A && git commit -m "fix flaky test"' })]),
    result('1', 'read', 'file'),
    result('2', 'bash', '[feat/flaky 3fa9c21] fix flaky test\n 1 file changed, 2 insertions(+)'),
    assistant([call('3', 'bash', { command: 'git push origin feat/flaky' })]),
    result('3', 'bash', 'To github.com:x/y.git\n   9d8e7f6..3fa9c21  feat/flaky -> feat/flaky'),
    assistant([call('4', 'bash', { command: 'git push -u origin new-branch' })]),
    result('4', 'bash', ' * [new branch]      new-branch -> new-branch'),
    assistant([{ type: 'text', text: 'Fixed the flaky test\nand pushed it.' }]),
  ]);
  assert.equal(summary.tools, 4);
  assert.equal(summary.reply, 'Fixed the flaky test and pushed it.');
  assert.deepEqual(summary.commits, ['commit 3fa9c21 feat/flaky', 'push 9d8e7f6..3fa9c21 feat/flaky', 'push new new-branch']);
  assert.equal(summary.stopReason, 'stop');
});

test('only git commit and git push commands that succeeded count; other commands and their output do not', () => {
  const summary = summarizeTurn([
    assistant([call('1', 'bash', { command: 'git log --oneline | head' }), call('2', 'bash', { command: 'git commit -m x' }), call('3', 'powershell', { command: 'git -C ../w push origin main' }),
      call('4', 'bash', { command: 'echo "[main abcdef0] not a commit"' })]),
    result('1', 'bash', '[main 1111111] old'),
    result('2', 'bash', 'nothing to commit, working tree clean', true),
    result('3', 'powershell', 'To x\n   aaaaaaa..bbbbbbb  main -> main'),
    result('4', 'bash', '[main abcdef0] not a commit'),
  ]);
  assert.deepEqual(summary.commits, ['push aaaaaaa..bbbbbbb main']);
  assert.equal(summary.tools, 4);
});

test('a turn that ended on an error or an abort carries that, and one with no text has an empty reply', () => {
  assert.deepEqual(summarizeTurn([assistant([call('1', 'bash', { command: 'ls' })], 'aborted')]), { reply: '', tools: 1, commits: [], stopReason: 'aborted' });
  const failed = summarizeTurn([assistant([{ type: 'text', text: 'trying' }]), assistant([], 'error', '429 quota exhausted')]);
  assert.equal(failed.stopReason, 'error'); assert.equal(failed.reply, '429 quota exhausted');
  assert.deepEqual(summarizeTurn([]), { reply: '', tools: 0, commits: [] });
});

const at = (hour: number, minute = 0, day = 15) => new Date(2026, 5, day, hour, minute).getTime();
const wake = (fields: Partial<WakeRecord>): WakeRecord => ({ at: at(9), trigger: 'schedule', reason: '', outcome: 'done', ...fields });

test('the report lists today\'s wakes with time, trigger, outcome, commits, and what is left of the daily budget', () => {
  const text = renderReport([
    wake({ at: at(1, 5, 14), reason: 'yesterday', endedAt: at(1, 9, 14), reply: 'old news' }),
    wake({ at: at(9, 5), endedAt: at(9, 21), reply: 'Fixed the flaky test and pushed it.', tools: 7, commits: ['commit 3fa9c21 feat/flaky', 'push 9d8e7f6..3fa9c21 feat/flaky'] }),
    wake({ at: at(13, 0), trigger: 'check', reason: 'merge PR 12', outcome: 'interrupted', endedAt: at(13, 4), reply: 'stopping', tools: 1 }),
    wake({ at: at(15, 30), outcome: 'unsettled' }),
    wake({ at: at(16, 0), outcome: 'running' }),
  ], { now: at(16, 30), cap: 6, minutes: 30 });
  const lines = text.split('\n');
  assert.match(lines[0], /4 wakes today/);
  assert.match(text, /2 of 6 wakes left/, 'rolling 24 h budget: the wake at 01:05 yesterday is out, four are in');
  assert.ok(!text.includes('old news'));
  assert.match(text, /09:05 .*schedule.*done.*16 min.*7 tools.*Fixed the flaky test/);
  assert.match(text, /commit 3fa9c21 feat\/flaky/); assert.match(text, /push 9d8e7f6\.\.3fa9c21 feat\/flaky/);
  assert.match(text, /13:00 .*check: merge PR 12.*interrupted.*stopping/);
  assert.match(text, /15:30 .*never settled/i);
  assert.match(text, /16:00 .*still running/i);
});

test('a day with no wakes says so and still shows the budget; an off heartbeat is named', () => {
  assert.match(renderReport([], { now: at(10), cap: 6, minutes: 30 }), /no wakes today[^]*6 of 6 wakes left/i);
  assert.match(renderReport([], { now: at(10), cap: 6, minutes: 0 }), /off/i);
});

test('a long reply is cut for the listing', () => {
  assert.ok(renderReport([wake({ endedAt: at(9, 1), reply: 'y'.repeat(300) })], { now: at(10), cap: 6, minutes: 30 }).length < 400);
});

test('/heartbeat prints the report, /heartbeat queue lists, /heartbeat add appends; anything else is a usage error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beat-cmd-'));
  const context = { dir, now: at(10), cap: 6, minutes: 30 };
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ wakes: [at(9)], checks: [], wakeLog: [wake({ endedAt: at(9, 3), reply: 'did it', tools: 2 })] }));
  assert.match(heartbeatCommand('', context), /1 wake today[^]*did it/);
  assert.match(heartbeatCommand('report', context), /did it/);
  assert.match(heartbeatCommand('queue', context), /empty/i);
  assert.match(heartbeatCommand('add  triage the inbox ', context), /triage the inbox/);
  assert.match(readFileSync(queueFile(dir), 'utf8'), /^- \[ \] triage the inbox$/m);
  assert.match(heartbeatCommand('queue', context), /\[ \] triage the inbox/);
  assert.throws(() => heartbeatCommand('add', context), /Usage/);
  assert.throws(() => heartbeatCommand('bogus', context), /Usage/);
  rmSync(dir, { recursive: true, force: true });
});

test('the report command works before any heartbeat.json exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beat-cmd-'));
  assert.match(heartbeatCommand('', { dir, now: at(10), cap: 6, minutes: 30 }), /no wakes today/i);
  rmSync(dir, { recursive: true, force: true });
});

test('the cheap check also sees the next queue item as an open job', () => {
  const text = beatSnapshot({ view: 'v', state: '', idleMinutes: 30, agents: [], shells: [], queueItem: 'fix the flaky test' });
  assert.match(text, /work queue[^]*fix the flaky test/i);
  assert.doesNotMatch(beatSnapshot({ view: 'v', state: '', idleMinutes: 30, agents: [], shells: [] }), /work queue/i);
});
