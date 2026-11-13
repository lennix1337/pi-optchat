import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BOARD_LINES, NOTE_CHARS, cut, STALL_MS, WaitingBoard, boardNote, boardView, expandedView, hhmm, lastLine, overflowText, phaseOf, span, waitAge, type BoardInput, type BoardRun, type BoardShell, type WaitItem } from '../src/waiting-board.ts';
import type { RunInfo } from '../src/runs.ts';
import type { ShellJob } from '../src/shells.ts';
import { atWork } from '../src/transcript.ts';
import { BoardNavigation, mountWaitingBoard, renderExpandedBoard, renderWaitingBoard } from '../src/navigation.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';

// 2026-11-11 16:49 UTC is 13:49 in Brasília.
const NOW = Date.parse('2026-11-11T16:49:00Z');
const MIN = 60_000, HOUR = 60 * MIN;
const run = (over: Partial<BoardRun> = {}): BoardRun => ({ id: 'a1b2c3d4', task: 'Fix the flaky wake test', cwd: 'C:/projetos/pi-optchat', model: 'anthropic-account-2/claude-sonnet-5-5', state: 'running', started: NOW - 12 * MIN, updated: NOW - 5_000, toolAt: NOW - 5_000, phase: 'testes', ...over });
const shell = (over: Partial<BoardShell> = {}): BoardShell => ({ id: '3f9a1c2e-aaaa-bbbb-cccc-111122223333', command: 'npm run verify', state: 'running', started: NOW - 3 * MIN, last: 'ok 412 - wake recovers', ...over });
const ask = (over: Partial<WaitItem> = {}): WaitItem => ({ text: 'DentAI cache HTML: libera o deploy web?', id: 'c1', choices: ['sim', 'não'], since: NOW - 44 * HOUR, ...over });
const input = (over: Partial<BoardInput> = {}): BoardInput => ({ now: NOW, runs: [], shells: [], ...over });
const texts = (over: Partial<BoardInput>, max?: number) => boardView(input(over), max).lines.map(l => l.text);
const plain = (_tone: string, text: string) => text;

test('nothing pending is an empty board, and no note for the model', () => {
  const view = boardView(input());
  assert.deepEqual(view, { lines: [], more: 0, pending: 0, waiting: 0, now: NOW });
  assert.equal(boardNote(view), undefined);
  assert.equal(boardNote(boardView(input({ runs: [run({ state: 'completed', ended: NOW - 11 * MIN })] }))), undefined, 'a worker finished over ten minutes ago is gone');
});

test('a running worker shows its project, goal, what it is doing in words, elapsed time and the short model', () => {
  assert.deepEqual(texts({ runs: [run()] }), ['pi-optchat · Fix the flaky wake test · testes · 12m · sonnet']);
  assert.deepEqual(texts({ runs: [run({ phase: undefined })] }), ['pi-optchat · Fix the flaky wake test · 12m · sonnet'], 'no tool yet: no phase');
  assert.deepEqual(texts({ runs: [run({ cwd: 'C:/projetos/pi-optchat/.worktrees/board-nav' })] }), ['pi-optchat · Fix the flaky wake test · testes · 12m · sonnet'], 'a worktree belongs to its project');
  assert.deepEqual(texts({ runs: [run({ project: 'gitwatch' }), run({ id: 'b2', project: 'optchat', phase: 'editando' })] }), [
    'gitwatch · Fix the flaky wake test · testes · 12m · sonnet', 'optchat  · Fix the flaky wake test · editando · 12m · sonnet'], 'the project column lines up');
});

test('the last tool becomes a phase in words: reading, testing, editing, git; any other tool keeps its name; never a tool count', () => {
  assert.equal(phaseOf('read', { path: 'a.ts' }), 'lendo código');
  assert.equal(phaseOf('grep', {}), 'lendo código');
  assert.equal(phaseOf('edit', {}), 'editando');
  assert.equal(phaseOf('write', {}), 'editando');
  assert.equal(phaseOf('project_checks', {}), 'testes');
  assert.equal(phaseOf('bash', { command: 'cd /x && npm run -s test:one -- test/a.test.ts; echo rc=$?' }), 'testes');
  assert.equal(phaseOf('bash', { command: 'npx tsc --noEmit -p .' }), 'testes');
  assert.equal(phaseOf('bash', { command: 'git status --short' }), 'git');
  assert.equal(phaseOf('bash', { command: 'cd /x && gh pr view 4' }), 'git');
  assert.equal(phaseOf('bash', { command: 'ls src' }), 'bash');
  assert.equal(phaseOf('crew', {}), 'crew');
  assert.equal(/tools?\b/.test(texts({ runs: [run()] })[0]), false);
});

test('a worker with no tool for over ten minutes is stalled, in warning tone; a long tool call is not silence', () => {
  const stalled = boardView(input({ runs: [run({ toolAt: NOW - 11 * MIN, updated: NOW - 11 * MIN })] })).lines[0];
  assert.equal(stalled.text, 'pi-optchat · Fix the flaky wake test · parado há 11m · 12m · sonnet');
  assert.equal(stalled.tone, 'wait');
  assert.equal(boardView(input({ runs: [run()] })).lines[0].tone, 'active');
  assert.match(texts({ runs: [run({ toolAt: NOW - 9 * MIN })] })[0], /· testes ·/, 'nine minutes is still working');
  assert.match(texts({ runs: [run({ toolAt: NOW - 30 * MIN, inTool: true })] })[0], /· testes ·/, 'a tool still running is not stalled');
  assert.match(texts({ runs: [run({ toolAt: undefined, started: NOW - STALL_MS - MIN })] })[0], /parado há 11m/, 'never ran a tool: counted from the start');
});

test('a long goal, command and output line are cut to their budgets', () => {
  const [w, s] = texts({ runs: [run({ task: 'x'.repeat(200) })], shells: [shell({ command: 'y'.repeat(200), last: 'z'.repeat(200) })] });
  assert.equal(w.match(/(x+…)/)![1].length, 44, 'goal: 44 characters with the ellipsis');
  assert.equal(s.match(/(y+…)/)![1].length, 40, 'command: 40');
  assert.equal(s.match(/(z+…)/)![1].length, 50, 'last output line: 50');
});

test('elapsed time reads 45s, 4m, 1h05, and a wait reads 5m, 44h, 3d', () => {
  assert.deepEqual([45_000, 4 * MIN + 59_000, 65 * MIN, 0, -5].map(span), ['45s', '4m', '1h05', '0s', '0s']);
  assert.deepEqual([5 * MIN, 44 * HOUR, 47 * HOUR, 72 * HOUR, -1].map(waitAge), ['5m', '44h', '47h', '3d', '0m']);
});

test('times are Brasília time, whatever the machine zone', () => {
  assert.equal(hhmm(NOW), '13:49');
  assert.equal(hhmm(Date.parse('2026-11-12T02:30:00Z')), '23:30', 'the day before in UTC-3');
});

test('a running shell says it is a shell, then its command, elapsed time and last output line; ANSI and blank lines are dropped', () => {
  assert.deepEqual(texts({ shells: [shell()] }), ['shell npm run verify · 3m · ok 412 - wake recovers']);
  assert.equal(lastLine('first\n\u001b[32mgreen line\u001b[0m\n\n  \n'), 'green line');
});

test('a shell line drops a leading cd, names the directory instead and says how it ended; the id is only in the model\'s note', () => {
  const cd = 'cd C:/projetos/pi-optchat && grep -n "Inspector" src/index.ts | head -5';
  const done = boardView(input({ shells: [shell({ command: cd, state: 'completed', ended: NOW - MIN, exitCode: 0, last: undefined, id: 'cd8f3ec5-0000' })] })).lines[0];
  assert.equal(done.text, '✓ shell pi-optchat: grep -n "Inspector" src/index.ts | head… ok · 13:48');
  const [quoted, windows, plain, failed, noExit] = texts({ shells: [
    shell({ id: 'aaaaaaaa', command: 'cd "C:\\Users\\x\\my repo\\" && npm test', last: undefined }), shell({ id: 'bbbbbbbb', command: 'cd /d C:\\work\\app; npm run build', last: undefined }),
    shell({ id: 'cccccccc', command: 'cd', last: undefined }),
    shell({ id: 'dddddddd', command: 'npm test', state: 'failed', ended: NOW - MIN, exitCode: 2, last: undefined }), shell({ id: 'eeeeeeee', command: 'npm test', state: 'failed', ended: NOW - MIN, last: undefined })] });
  assert.equal(quoted.startsWith('shell my repo: npm test'), true, quoted);
  assert.equal(windows.startsWith('shell app: npm run build'), true, windows);
  assert.equal(plain.startsWith('shell cd ·'), true, 'a bare cd is left alone');
  assert.equal(failed, '✗ shell npm test falhou rc 2 · 13:48');
  assert.equal(noExit, '✗ shell npm test falhou · 13:48');
});

test('a stopped shell leaves no line', () => {
  assert.deepEqual(texts({ shells: [shell({ state: 'stopped', ended: NOW - MIN })] }), []);
});

test('a parked worker says when it tries again, a paused one says paused, a stopping one says so', () => {
  assert.deepEqual(texts({ runs: [run({ id: 'p1', state: 'interrupted', until: NOW + 31 * MIN, updated: undefined })] }), ['pi-optchat · Fix the flaky wake test · ⏸ cota esgotada, volta às 14:20 · 12m · sonnet']);
  assert.match(texts({ runs: [run({ id: 'p2', state: 'paused' })] })[0], /pausado, aguarda você · 12m/);
  assert.match(texts({ runs: [run({ id: 'p3', state: 'stopping' })] })[0], /· parando · 12m/);
  assert.deepEqual(texts({ runs: [run({ state: 'interrupted' })] }), [], 'interrupted without a retry time is history');
});

test('a PR in CI shows its repo, number, checks, time pending and auto-merge; the model\'s note names it owner/repo#N', () => {
  const gitwatch = { polledAt: NOW - 10_000, prs: [{ repo: 'swlucas05/pi-optchat', number: 280, title: 'x', url: 'u', head: 'h', mergeState: 'CLEAN', autoMerge: true, checks: { pass: 2, fail: 0, pending: 3 }, pendingSince: NOW - 4 * MIN, next: undefined }] };
  assert.deepEqual(texts({ gitwatch }), ['pi-optchat #280 · CI 2/5 · 4m · auto-merge']);
  assert.equal(boardNote(boardView(input({ gitwatch })))!.split('\n')[1], '- swlucas05/pi-optchat#280 · CI 2/5 · 4m · auto-merge');
  const failing = { prs: [{ repo: 'o/r', number: 1, checks: { pass: 1, fail: 2, pending: 0 }, mergeState: 'DIRTY' }] };
  assert.deepEqual(texts({ gitwatch: failing }), ['r #1 · CI 1/3 ✗2 · conflito']);
  assert.equal(boardView(input({ gitwatch: failing })).lines[0].tone, 'bad');
});

test('gitwatch state with missing or unknown fields is tolerated; no state means no PR lines', () => {
  assert.deepEqual(texts({ gitwatch: { prs: [{ repo: 'o/r', number: 7 }, { number: 8 }, 'junk', null, { repo: 'o/r', number: 9, checks: { pass: 'x' }, pendingSince: 'soon', extra: 1 }], branches: 'no', polledAt: 'never' } }), ['r #7', 'r #9 · sem CI']);
  assert.deepEqual(texts({ gitwatch: {} }), []);
  assert.deepEqual(texts({}), []);
});

test('an old gitwatch snapshot is shown with its age; a branch only shows while its CI is not green', () => {
  const gitwatch = { polledAt: NOW - 9 * MIN, prs: [{ repo: 'o/r', number: 2, checks: { pass: 5, fail: 0, pending: 0 } }],
    branches: [{ repo: 'o/r', branch: 'feat/waiting-board', checks: { pass: 1, fail: 0, pending: 2 }, pendingSince: NOW - 2 * MIN }, { repo: 'o/r', branch: 'main', checks: { pass: 4, fail: 0, pending: 0 } }] };
  assert.deepEqual(texts({ gitwatch }).sort(), ['r #2 · CI 5/5 · dados de 9m atrás', 'r feat/waiting-board · CI 1/3 · 2m · dados de 9m atrás'].sort());
});

test('what waits on the operator is a question with its answers and its age, first; the compact board shows one and counts them all', () => {
  assert.deepEqual(texts({ waiting: [ask()], runs: [run()] })[0], 'DentAI cache HTML: libera o deploy web? [sim/não] · 44h');
  assert.equal(boardView(input({ waiting: [ask()] })).lines[0].tone, 'wait');
  assert.equal(texts({ waiting: [{ text: 'Resumo das 07:00 v2', ask: 'Confirmar se o DM chegou', choices: ['chegou', 'não chegou'], since: NOW - 5 * MIN }] })[0], 'Resumo das 07:00 v2: Confirmar se o DM chegou? [chegou/não chegou] · 5m', 'a question mark is added when there are answers');
  assert.equal(texts({ waiting: [{ text: 'revisar o PR #12' }] })[0], 'revisar o PR #12', 'no choices, no age: only the text');
  const many = boardView(input({ waiting: [ask(), ask({ text: 'b', id: 'c2' }), ask({ text: 'c', id: 'c3' })] }));
  assert.equal(many.waiting, 3); assert.equal(many.pending, 3); assert.equal(many.lines.length, 1);
  assert.equal(boardView(input({ waiting: [ask({ text: 'x'.repeat(90) })] })).lines[0].text.split(' [')[0].length, 60, 'compact question: 60 characters');
});

test('a success fades in four minutes, any shell in ninety seconds (failed too: the model already has its result), a failure stays ten; the compact board shows three, the focused one all', () => {
  const shells = [shell({ id: 's-ok', command: 'sleep 25', state: 'completed', started: NOW - 3 * MIN, ended: NOW - 2 * MIN, exitCode: 0, last: undefined }),
    shell({ id: 's-new', command: 'ls', state: 'completed', started: NOW - MIN, ended: NOW - MIN, exitCode: 0, last: undefined }),
    shell({ id: 's-bad', command: 'npm test', state: 'completed', started: NOW - 9 * MIN, ended: NOW - 8 * MIN, exitCode: 1, last: undefined })];
  const runs = [run({ id: 'w-old', state: 'completed', ended: NOW - 5 * MIN }), run({ id: 'w-new', task: 'Second', state: 'completed', ended: NOW - 3 * MIN }),
    run({ id: 'w-bad', task: 'Third', state: 'failed', ended: NOW - 7 * MIN })];
  const compact = boardView(input({ runs, shells }));
  assert.deepEqual(compact.lines.map(l => l.text), [
    '✓ shell ls ok · 13:48',
    '✓ pi-optchat · Second concluído · 13:46',
    '✗ pi-optchat · Third falhou · 13:42',
  ], 'a shell done two minutes ago and a worker done five are gone; three finished lines at most');
  assert.equal(compact.more, 0, 'a shell that failed eight minutes ago has left the compact board');
  const fourth = boardView(input({ runs, shells: [...shells, shell({ id: 's-bad2', command: 'npm run lint', state: 'completed', started: NOW - MIN, ended: NOW - MIN, exitCode: 1, last: undefined })] }));
  assert.equal(fourth.more, 1, 'a finished line past the cap is counted, not dropped');
  assert.match(renderWaitingBoard(fourth, 80, plain, 'f6').at(-1)!, /\+1 mais · f6 inspecionar/);
  assert.equal(expandedView(input({ runs, shells })).lines.length, 6, 'the focused board keeps all ten minutes');
});

test('finished work stays ten minutes, newest first after the pending lines: workers, shells and gitwatch notices', () => {
  const notices = [{ repo: 'swlucas05/pi-optchat', wake: true, text: 'PR #279 merged', at: NOW - 2 * MIN, events: [{ pr: 279, kind: 'merged', text: 'merged abc1234' }] },
    { repo: 'o/r', at: NOW - 11 * MIN, events: [{ pr: 1, kind: 'merged', text: 'merged' }] },
    { repo: 'o/r', at: new Date(NOW - 3 * MIN).toISOString(), events: [{ pr: 5, kind: 'checks', text: 'checks failed: lint' }, { pr: 5, kind: 'push', text: 'new head f00' }] }];
  const view = expandedView(input({
    runs: [run({ id: 'w1', state: 'completed', ended: NOW - 4 * MIN }), run({ id: 'w2', state: 'failed', ended: NOW - 6 * MIN }), run({ id: 'w3', state: 'running' })],
    shells: [shell({ state: 'completed', ended: NOW - 5 * MIN, exitCode: 0, last: undefined })], notices }));
  const lines = view.lines.map(l => l.text);
  assert.equal(lines[0].startsWith('pi-optchat · Fix'), true, 'pending first');
  assert.deepEqual(lines.slice(1), [
    '✓ pi-optchat #279 mergeado · 13:47',
    '✗ r #5 CI falhou: lint · 13:46',
    '✓ pi-optchat · Fix the flaky wake test concluído · 13:45',
    '✓ shell npm run verify ok · 13:44',
    '✗ pi-optchat · Fix the flaky wake test falhou · 13:43',
  ]);
  assert.deepEqual([...new Set(view.lines.map(l => l.section))], ['working', 'done']);
});

test('the expanded board keeps each question and each shell whole, with the shell\'s last output line, and lists every question', () => {
  const waiting = [ask({ text: 'aprovar o deploy da 1.4.1 em produção depois de conferir o changelog inteiro com a Beatriz', choices: undefined, since: undefined }), ask({ text: 'decidir X', choices: undefined, since: undefined }), ask({ text: 'responder o PR #12', choices: undefined, since: undefined }), ask({ text: 'liberar a cota', choices: undefined, since: undefined })];
  const command = 'cd C:/projetos/pi-optchat && grep -n "Inspector" src/index.ts src/navigation.ts src/waiting-board.ts test/navigation.test.ts';
  const inp = input({ waiting, shells: [shell({ command, state: 'completed', ended: NOW - MIN, exitCode: 0, last: 'src/index.ts:93: import { x }' })] });
  const compact = boardView(inp), full = expandedView(inp);
  assert.equal(compact.lines.filter(l => l.section === 'waiting').length, 1, 'compact: one question');
  assert.equal(compact.lines[0].text, 'aprovar o deploy da 1.4.1 em produção depois de conferir o…');
  assert.deepEqual(full.lines.filter(l => l.section === 'waiting').map(l => l.text), waiting.map(w => w.text));
  assert.equal(full.lines.at(-1)!.text, '✓ shell pi-optchat: grep -n "Inspector" src/index.ts src/navigation.ts src/waiting-board.ts test/navigation.test.ts ok · 13:48\nsaída: src/index.ts:93: import { x }');
  assert.equal(full.more, 0);
  const many = expandedView(input({ runs: Array.from({ length: 9 }, (_, i) => run({ id: `r${i}` })) }));
  assert.equal(many.lines.length, 9, 'no overflow in the expanded view');
  assert.equal(new WaitingBoard({ runs: () => [], live: () => undefined, shells: () => [], waiting: () => waiting, now: () => NOW }).expanded().lines.length, 4);
  assert.equal(boardView(inp, 12, true).lines.filter(l => l.section === 'waiting').length, 4, 'the model\'s note asks for every question too');
});

test('the focused board draws every item wrapped to the width, a cursor on one and the keys that move it', () => {
  const waiting = [ask({ text: 'aprovar o deploy da 1.4.1 em produção depois de conferir o changelog inteiro com a Beatriz', choices: undefined, since: undefined }), ask({ text: 'decidir X', choices: undefined, since: undefined }), ask({ text: 'responder o PR #12', choices: undefined, since: undefined })];
  const view = expandedView(input({ waiting }));
  const lines = renderExpandedBoard(view.lines, 1, 40, plain);
  assert.equal(lines.every(l => visibleWidth(l) <= 40), true);
  assert.equal(lines.filter(l => l.includes('›')).length, 1);
  assert.equal(lines.find(l => l.includes('›'))!, ' › decidir X', 'the cursor is on the second item');
  assert.equal(lines[0], 'Esperando você (3)');
  const text = lines.map(l => l.slice(3).trim()).join(' ');
  for (const w of waiting) for (const word of w.text.split(' ')) assert.equal(text.includes(word), true, word);
  assert.equal(lines.at(-1), ' ↑↓ mover · Esc voltar');
  assert.equal(lines.length > view.lines.length + 2, true, 'the long item wraps onto more rows');
});

test('over the line cap the last line counts what is left and the shortcut inspects it', () => {
  const runs = Array.from({ length: 10 }, (_, i) => run({ id: `r${i}`, updated: NOW - i * 1000 }));
  const view = boardView(input({ runs }));
  assert.equal(view.lines.length, BOARD_LINES - 1);
  assert.equal(view.more, 3);
  assert.equal(overflowText(view.more, 'F6 inspect'), '+3 mais · F6 inspect');
  assert.equal(boardView(input({ runs: runs.slice(0, BOARD_LINES) })).more, 0, 'exactly the cap fits');
});

test('the board gathers live state: the last tool as a phase, silence from the run, background shells only, pi-subagents rows left out', () => {
  const events = new EventEmitter(), emitted: string[] = [];
  const bus = { on: (c: string, h: (d: unknown) => void) => { events.on(c, h); return () => events.off(c, h); }, emit: (c: string, d: unknown) => { emitted.push(c); events.emit(c, d); } };
  const info = (over: Partial<RunInfo>): RunInfo => ({ id: 'a1b2c3d4', task: 'Fix', cwd: 'C:/projetos/pi-optchat', model: 'p/m', thinking: 'high', parentSession: 's', started: NOW - MIN, depth: 0, state: 'running', guidance: [], ...over });
  const jobs = [{ id: 'bg-1-xxxxxxxx', command: 'npm test', cwd: '.', mode: 'background', state: 'running', started: NOW - MIN, output: 'a\nb', notify: 'end' }, { id: 'fg', command: 'ls', cwd: '.', mode: 'foreground', state: 'running', started: NOW, output: '', notify: 'end' }] as ShellJob[];
  let waiting = 0, clock = NOW;
  const board = new WaitingBoard({
    runs: () => [info({}), info({ id: 'ext', source: 'pi-subagents' })], live: id => id === 'a1b2c3d4' ? { updated: NOW - 1000, toolAt: NOW - 1000, lastTool: { name: 'bash', args: { command: 'npm test' } } } : undefined,
    shells: () => jobs, waiting: () => { waiting++; return [{ text: 'decidir X' }]; }, now: () => clock }, bus);
  board.requestState();
  assert.deepEqual(emitted, ['gitwatch:state:request:v1']);
  let redraws = 0; board.subscribe(() => redraws++);
  events.emit('gitwatch:state:v1', { polledAt: NOW, prs: [{ repo: 'o/pi-optchat', number: 280, checks: { pass: 1, fail: 0, pending: 1 }, pendingSince: NOW - 4 * MIN, autoMerge: true }] });
  events.emit('gitwatch:notice:v1', { repo: 'o/pi-optchat', wake: true, text: 'merged', at: NOW - MIN, events: [{ pr: 279, kind: 'merged', text: 'merged' }] });
  events.emit('gitwatch:state:v1', 'garbage');
  assert.equal(redraws, 2, 'each valid event redraws; garbage does not');
  assert.deepEqual(board.view().lines.map(l => l.text), [
    'decidir X', 'pi-optchat · Fix · testes · 1m · m', 'shell npm test · 1m · b', 'pi-optchat #280 · CI 1/2 · 4m · auto-merge', '✓ pi-optchat #279 mergeado · 13:48']);
  board.view(); board.view();
  assert.equal(waiting, 1, 'the commitments file is read at most once per few seconds');
  clock += 6_000; board.view();
  assert.equal(waiting, 2);
  board.close(); events.emit('gitwatch:state:v1', { prs: [] });
  assert.equal(redraws, 2, 'closed: no more redraws');
});

test('the model\'s note carries the same lines as the widget plus the ids, minus the finished ones, under 600 characters', () => {
  const view = boardView(input({
    waiting: [ask()],
    runs: [run(), run({ id: 'b2c3d4e5', task: 'Review the quota gate diff', phase: 'lendo código', updated: NOW - 20_000 }), run({ id: 'dead', state: 'completed', ended: NOW - MIN })],
    shells: [shell()], gitwatch: { prs: [{ repo: 'o/pi-optchat', number: 280, checks: { pass: 2, fail: 0, pending: 3 }, pendingSince: NOW - 4 * MIN, autoMerge: true }] } }));
  const note = boardNote(view)!;
  assert.equal(view.lines.some(l => l.finished), true);
  assert.equal(note.length < NOTE_CHARS, true, `${note.length} chars`);
  assert.deepEqual(note.split('\n').slice(1), [
    '- DentAI cache HTML: libera o deploy web? [sim/não] · 44h [c1]',
    '- pi-optchat · Fix the flaky wake test · testes · 12m · sonnet [a1b2c3d4]',
    '- pi-optchat · Review the quota gate diff · lendo código · 12m · sonnet [b2c3d4e5]',
    '- shell npm run verify · 3m · ok 412 - wake recovers [3f9a1c2e]',
    '- o/pi-optchat#280 · CI 2/5 · 4m · auto-merge']);
  assert.equal(note.startsWith('13:49 pendente:\n'), true);
  assert.equal(atWork(view), `[OptChat status] ${note}`);
});

test('a note that does not fit says how many lines it left out, and never passes the budget', () => {
  const view = boardView(input({ runs: Array.from({ length: 5 }, (_, i) => run({ id: `r${i}`, task: 'T'.repeat(80), updated: NOW - i })) }));
  const note = boardNote(view, 300)!;
  assert.equal(note.length <= 300, true, `${note.length}`);
  assert.match(note, /\n\+\d+ mais$/);
  assert.equal(note.split('\n').length - 2 + Number(note.match(/\+(\d+) mais$/)![1]), 5, 'every line is shown or counted');
});

test('the widget draws sections with headers, the question marked, coloured by tone, cut to the terminal and counting the overflow', () => {
  const view = boardView(input({ waiting: [ask(), ask({ text: 'b' })], runs: Array.from({ length: 10 }, (_, i) => run({ id: `r${i}`, updated: NOW - i * 1000 })) }));
  const ESC = String.fromCharCode(27), CODE: Record<string, number> = { muted: 90, dim: 2, warning: 33 };
  const lines = renderWaitingBoard(view, 200, (tone, text) => `${ESC}[${CODE[tone] ?? 0}m${text}${ESC}[0m`, 'f6');
  assert.equal(lines.length, BOARD_LINES + 2, 'the lines the cap allows, one header per section and the overflow line');
  const on = (tone: string, text: string) => `${ESC}[${CODE[tone]}m${text}${ESC}[0m`;
  assert.equal(lines[0], `${on('muted', 'Esperando você (2)')}${' '.repeat(200 - 'Esperando você (2)'.length - '↑ abre'.length)}${on('dim', '↑ abre')}`);
  assert.equal(lines[1], ` ${on('warning', '▸')} ${on('warning', 'DentAI cache HTML: libera o deploy web? [sim/não] · 44h')}`);
  assert.equal(lines[2], on('muted', 'Trabalhando (10)'));
  assert.equal(lines.at(-1), `   ${on('dim', '+4 mais · f6 inspecionar')}`);
  assert.ok(renderWaitingBoard(view, 60, plain, 'f6').every(line => visibleWidth(line) <= 60), 'cut to the terminal');
  assert.deepEqual(renderWaitingBoard(boardView(input()), 60, plain, 'f6'), [], 'nothing to wait on, no widget');
});

test('mounting puts the board in the optchat-waiting widget, redraws on gitwatch events and removes it on unmount', () => {
  const events = new EventEmitter();
  const bus = { on: (c: string, h: (d: unknown) => void) => { events.on(c, h); return () => events.off(c, h); }, emit: () => {} };
  const board = new WaitingBoard({ runs: () => [], live: () => undefined, shells: () => [], waiting: () => [], now: () => NOW }, bus);
  const widgets = new Map<string, unknown>(); let redraws = 0, widget: { render(width: number): string[] } | undefined;
  const ctx = { ui: { setWidget: (key: string, factory?: (tui: unknown, theme: unknown) => { render(width: number): string[] }) => {
    if (!factory) { widgets.delete(key); return; }
    widget = factory({ requestRender: () => { redraws++; } }, { fg: (_tone: string, text: string) => text }); widgets.set(key, widget);
  } } };
  mock.timers.enable({ apis: ['setInterval'] });
  const unmount = mountWaitingBoard(ctx as unknown as ExtensionContext, board, 'f6');
  assert.deepEqual([...widgets.keys()], ['optchat-waiting']);
  assert.deepEqual(widget!.render(80), []);
  events.emit('gitwatch:state:v1', { polledAt: NOW, prs: [{ repo: 'o/pi-optchat', number: 280, checks: { pass: 2, fail: 0, pending: 3 }, pendingSince: NOW - 4 * MIN, autoMerge: true }] });
  assert.equal(redraws, 1);
  mock.timers.tick(1000);
  assert.equal(redraws, 2, 'the tick repaints while the board shows lines, so elapsed times move');
  assert.deepEqual(widget!.render(80), ['Trabalhando (1)'.padEnd(80 - '↑ abre'.length) + '↑ abre', '   pi-optchat #280 · CI 2/5 · 4m · auto-merge']);
  unmount(); board.close(); mock.timers.reset();
  assert.equal(widgets.size, 0);
});

test('mounted, the widget keeps the compact look until the board is focused, then lists every question and goes back on Esc', () => {
  const waiting = ['aprovar o deploy', 'decidir X', 'responder o PR #12', 'liberar a cota'].map(text => ({ text }));
  const board = new WaitingBoard({ runs: () => [], live: () => undefined, shells: () => [], waiting: () => waiting, now: () => NOW });
  const nav = new BoardNavigation(board); let widget: { render(width: number): string[] } | undefined;
  const ctx = { ui: { setWidget: (_key: string, factory?: (tui: unknown, theme: unknown) => { render(width: number): string[] }) => { if (factory) widget = factory({ requestRender: () => {} }, { fg: (_tone: string, text: string) => text }); } } };
  mock.timers.enable({ apis: ['setInterval'] });
  const unmount = mountWaitingBoard(ctx as unknown as ExtensionContext, board, 'f6', nav);
  const compact = ['Esperando você (4)'.padEnd(80 - '↑ abre'.length) + '↑ abre', ' ▸ aprovar o deploy'];
  assert.deepEqual(widget!.render(80), compact);
  nav.handle('\x1b[A', true, false);
  assert.deepEqual(widget!.render(80), ['Esperando você (4)', ' › aprovar o deploy', ' ▸ decidir X', ' ▸ responder o PR #12', ' ▸ liberar a cota', ' ↑↓ mover · Esc voltar']);
  nav.handle('\x1b', true, false);
  assert.deepEqual(widget!.render(80), compact);
  unmount(); board.close(); mock.timers.reset();
});

// A worker's task is the shared prefix, then the contract: Goal, Acceptance, Evidence, Authority.
const BRIEF = ["You are a subagent. Don't write memory pages.", '', 'Context: the operator wants the board readable.', 'Goal: In pi-optchat, make the waiting board reachable from the keyboard. Then more.', 'Acceptance: tests in test/navigation.test.ts.', 'Evidence: red-before.', 'Authority: edit and commit locally.'].join('\n');

test('a worker line names the Goal of the contract, not the shared prefix, and the model by its short name', () => {
  const lines = texts({ runs: [run({ task: BRIEF, model: 'anthropic-account-2/claude-sonnet-5-5' }), run({ id: 'b2c3d4e5', task: "You are a subagent. Don't write memory pages.\n\nContext: Resolver o conflito de merge localmente", model: 'openai-codex/gpt-6.1-sol', updated: NOW - 9_000 })] });
  assert.equal(lines[0], 'pi-optchat · In pi-optchat, make the waiting board reach… · testes · 12m · sonnet');
  assert.equal(lines[1], 'pi-optchat · Resolver o conflito de merge localmente · testes · 12m · gpt-6.1-sol', 'no Goal: the first line that is not the prefix');
  assert.equal(lines.some(l => l.includes('You are a subagent')), false);
});

test('on a narrow terminal the goal gives way and the phase, time and model stay; at the smallest the line is cut at the edge', () => {
  const view = boardView(input({ runs: [run({ task: 'Goal: make the waiting board reachable from the keyboard, then more', project: 'optchat' })] }));
  const at = (width: number) => renderWaitingBoard(view, width, plain, 'f6')[1];
  assert.equal(at(80), '   optchat · make the waiting board reachable from the… · testes · 12m · sonnet');
  assert.equal(at(64), '   optchat · make the waiting board rea… · testes · 12m · sonnet');
  assert.equal(visibleWidth(at(30)) <= 30, true);
});

test('cut cleans only the head of a long text, and still marks the rest as cut', () => {
  const brief = `${' '.repeat(2000)}Goal: build it\n${'detalhe '.repeat(200_000)}`;
  const started = performance.now();
  for (let i = 0; i < 50; i++) cut(brief, 60);
  assert.ok(performance.now() - started < 50, 'a 1.6 MB brief must not be cleaned whole on every render');
  assert.equal(cut('curto', 60), 'curto');
  assert.equal(cut(`${' '.repeat(1000)}fim`, 60), '…');
  assert.match(cut(`Goal: x ${'a '.repeat(100)}`, 20), /^Goal: x a a a a a a…$/);
});
