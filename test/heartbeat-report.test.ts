import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beatSnapshot, previousWakeNote, type WakeRecord } from '../src/heartbeat.ts';
import { EMPTY_WAKE_RETRY, heartbeatCommand, MEMORY_REPLY_RETRY, memoryShapedReply, renderReport, summarizeTurn, wakeRetry } from '../src/heartbeat-report.ts';
import { queueFile } from '../src/heartbeat-queue.ts';
import { ACCEPT_CALL, acceptResult, FAILED, REFUSED, SHIPPED, UNCERTAIN } from './accept-answer.ts';

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

test('a ship.mjs run counts as a delivery: the PR it opened is logged, so the next wake is not told it committed nothing', () => {
  const summary = summarizeTurn([
    assistant([call('1', 'bash', { command: 'node scripts/ship.mjs -m "x" -b "y" src/a.ts 2>&1 | tail -6' })]),
    result('1', 'bash', 'url: "https://github.com/lennix1337/pi-optchat/pull/97"\nstate: OPEN\nauto_merge: queued'),
  ]);
  assert.deepEqual(summary.commits, ['pr https://github.com/lennix1337/pi-optchat/pull/97']);
});

test('a worker\'s branch shipped with crew accept counts as a delivery: its PR is logged, the wake is not sent back as empty and the next one is not told it committed nothing', async () => {
  // The answer quotes the worker's memory proposal, here with a line shaped like the PR line, and the reply names a third PR: this wake opened neither.
  const accepted = await acceptResult(SHIPPED, '- lição do worker\nPR: https://github.com/acme/app/pull/41');
  assert.equal(accepted.isError, false, accepted.text);
  assert.match(accepted.text, /^PR: https:\/\/github\.com\/acme\/app\/pull\/41$/m, 'the answer holds the quoted line');
  const summary = summarizeTurn([
    assistant([call('1', 'spawn', { tasks: [{ task: 'Goal: x', kind: 'code', project: 'harness' }] })], 'toolUse'), result('1', 'spawn', 'Spawned run-1'),
    assistant([call('2', 'crew', ACCEPT_CALL)], 'toolUse'), result('2', 'crew', accepted.text),
    assistant([{ type: 'text', text: 'Entreguei o trabalho do worker. A https://github.com/acme/app/pull/8 continua aberta.' }]),
  ]);
  assert.deepEqual(summary.commits, ['pr https://github.com/acme/app/pull/7']);
  assert.equal(wakeRetry(summary), undefined);
  assert.doesNotMatch(previousWakeNote(wake({ reply: summary.reply, tools: summary.tools, commits: summary.commits })), /committed nothing/);
  const manual = await acceptResult({ code: 3, out: 'status: not_queued\npr: 9\nurl: "https://github.com/acme/app/pull/9"\nreason: sem check obrigatório\nrc: 3\n' });
  assert.deepEqual(summarizeTurn([assistant([call('1', 'crew', ACCEPT_CALL)], 'toolUse'), result('1', 'crew', manual.text, manual.isError)]).commits,
    ['pr https://github.com/acme/app/pull/9'], 'a PR opened without auto-merge was opened all the same');
});

test('an accept that opened no PR it can name is not a delivery: refused, uncertain or never answered, and an accept answer under any other call, leave the wake empty', async () => {
  const [accepted, refused, failed, uncertain, killed] = await Promise.all([SHIPPED, REFUSED, FAILED, UNCERTAIN, { code: null, out: '' }].map(shipped => acceptResult(shipped)));
  assert.deepEqual([accepted.isError, refused.isError, failed.isError, uncertain.isError, killed.isError], [false, true, true, false, false]);
  assert.match(refused.text, /ship refused \(exit 2\)/);
  assert.match(failed.text, /ship failed \(exit 1\): gh recusou\nPR: https:\/\/github\.com\/acme\/app\/pull\/7$/, 'the error itself has a second line shaped like the PR line');
  assert.match(uncertain.text, /UNCERTAIN \(auto_merge\)/);
  assert.match(killed.text, /UNCERTAIN/);
  // ship reported the PR's number only; the line shaped like a PR line is the worker's quoted proposal, not what accept opened.
  const unnamed = await acceptResult({ code: 0, out: 'status: queued\npr: 7\nauto_merge: queued\nrc: 0\n' }, '- lição do worker\nPR: https://github.com/acme/app/pull/41');
  assert.match(unnamed.text, /^PR: #7 \(url not reported\)$/m);
  assert.match(unnamed.text, /^PR: https:\/\/github\.com\/acme\/app\/pull\/41$/m);
  const accept = assistant([call('1', 'crew', ACCEPT_CALL)], 'toolUse');
  const turns: [string, Parameters<typeof summarizeTurn>[0]][] = [
    ['refused', [accept, result('1', 'crew', refused.text, true)]],
    ['failed, with a PR line in its error', [accept, result('1', 'crew', failed.text, true)]],
    ['uncertain', [accept, result('1', 'crew', uncertain.text)]],
    ['killed', [accept, result('1', 'crew', killed.text)]],
    ['a PR without a URL beside a quoted PR line', [accept, result('1', 'crew', unnamed.text)]],
    ['never answered', [accept]],
    ['a crew read', [assistant([call('1', 'crew', { action: 'read', project: 'harness' })], 'toolUse'), result('1', 'crew', accepted.text)]],
    ['a shell that printed an accept answer', [assistant([call('1', 'bash', { command: 'cat notes.txt' })], 'toolUse'), result('1', 'bash', accepted.text)]],
  ];
  for (const [why, turn] of turns) {
    const summary = summarizeTurn([...turn, assistant([{ type: 'text', text: 'Nada entregue.' }])]);
    assert.deepEqual(summary.commits, [], why);
    assert.equal(wakeRetry(summary), EMPTY_WAKE_RETRY, why);
    assert.match(previousWakeNote(wake({ reply: summary.reply, tools: summary.tools, commits: summary.commits })), /committed nothing/, why);
  }
});

test('a wake reply shaped like a memory line is caught (03/11 16:35, 13/11 19:34); a real report is not', () => {
  const memoryLine = '104704-112 OptChat 03/11 15:57-16:20 BRT, read-only monitoring, no operator order beyond user 104994';
  assert.equal(memoryShapedReply(memoryLine), true);
  assert.equal(memoryShapedReply('105113+1|work: heartbeat'), true);
  assert.equal(memoryShapedReply('tool: bash ran tests; echo: 80 pass'), true);
  assert.equal(memoryShapedReply('Abri a PR #97 e o merge automático está programado.'), false);
  assert.equal(memoryShapedReply('2 PRs mergeadas às 15:30.'), false);
});

test('a memory-line reply is sent back even after tools ran and after the empty-wake nudge (13/11 19:34: "158821+1|work: ..." reached the operator)', () => {
  const leaked = { reply: '158821+1|work: heartbeat notice repeats that the wake is about to end', tools: 12, commits: [] };
  assert.equal(wakeRetry(leaked, { empty: true }), MEMORY_REPLY_RETRY);
  assert.equal(wakeRetry(leaked, { empty: true, memory: true }), undefined, 'each nudge goes once per wake');
  assert.equal(wakeRetry({ reply: 'Nada novo.', tools: 2, commits: [] }, { empty: true }), undefined);
  assert.doesNotMatch(MEMORY_REPLY_RETRY, /ran no tool/);
});

test('a wake that settles with no commit, push, PR or merge is sent back once to build something new (operator 08/11: "não quero que um wake não faça nada")', () => {
  const readOnly = summarizeTurn([
    assistant([call('1', 'bash', { command: 'gh pr list' })]), result('1', 'bash', ''),
    assistant([{ type: 'text', text: 'Nesta rodada não entreguei mudança de código; medi a economia de tokens.' }]),
  ]);
  assert.equal(wakeRetry(readOnly), EMPTY_WAKE_RETRY);
  assert.match(EMPTY_WAKE_RETRY, /new capability/);
  assert.match(EMPTY_WAKE_RETRY, /living assistant/);
  assert.equal(wakeRetry({ reply: '104704-112 OptChat read-only', tools: 0, commits: [] }), MEMORY_REPLY_RETRY);
  assert.equal(wakeRetry({ reply: 'PR #97 aberta.', tools: 3, commits: ['pr https://github.com/x/y/pull/97'] }), undefined);
  assert.equal(wakeRetry({ reply: '', tools: 1, commits: [], stopReason: 'aborted' }), undefined, 'an abort is the operator or a fault, not idleness');
  assert.equal(wakeRetry({ reply: '429', tools: 1, commits: [], stopReason: 'error' }), undefined);
});

test('a quiet commit and a gh pr merge count as delivery even when git prints no ref line', () => {
  const summary = summarizeTurn([
    assistant([call('1', 'bash', { command: 'git add -A && git commit -q -m "x" && git push -q; echo rc=$?' }), call('2', 'bash', { command: 'gh pr merge 62 --squash --delete-branch; echo rc=$?' })]),
    result('1', 'bash', 'rc=0'),
    result('2', 'bash', 'rc=0'),
  ]);
  assert.equal(summary.commits.length, 2);
  assert.match(summary.commits[1], /^ran gh pr merge 62/);
  assert.equal(wakeRetry(summary), undefined);
});

test('a wake started by a project signal or the build cadence says so in the listing', () => {
  const text = renderReport([
    wake({ at: at(9, 0), trigger: 'signal', reason: 'signal: genexus18mcp, harness' }),
    wake({ at: at(11, 0), trigger: 'build', reason: 'build cadence' }),
  ], { now: at(12), cap: 6, minutes: 15 });
  assert.match(text, /09:00 signal: genexus18mcp, harness → done/);
  assert.match(text, /11:00 build → done/);
  assert.ok(!text.includes('fixed schedule'));
});
