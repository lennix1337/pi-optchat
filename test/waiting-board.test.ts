import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BOARD_LINES, NOTE_CHARS, WaitingBoard, boardNote, boardView, expandedView, hhmm, lastLine, overflowText, span, toolBrief, type BoardInput, type BoardRun, type BoardShell } from '../src/waiting-board.ts';
import type { RunInfo } from '../src/runs.ts';
import type { ShellJob } from '../src/shells.ts';
import { atWork } from '../src/transcript.ts';
import { BoardNavigation, mountWaitingBoard, renderExpandedBoard, renderWaitingBoard } from '../src/navigation.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';

// 2026-11-11 16:49 UTC is 13:49 in Brasília.
const NOW = Date.parse('2026-11-11T16:49:00Z');
const MIN = 60_000;
const run = (over: Partial<BoardRun> = {}): BoardRun => ({ id: 'a1b2c3d4', task: 'Fix the flaky wake test', model: 'anthropic-account-2/claude-sonnet-5-5', state: 'running', started: NOW - 12 * MIN, updated: NOW - 5_000, tools: 31, last: 'npm test', ...over });
const shell = (over: Partial<BoardShell> = {}): BoardShell => ({ id: '3f9a1c2e-aaaa-bbbb-cccc-111122223333', command: 'npm run verify', state: 'running', started: NOW - 3 * MIN, last: 'ok 412 - wake recovers', ...over });
const input = (over: Partial<BoardInput> = {}): BoardInput => ({ now: NOW, runs: [], shells: [], ...over });
const texts = (over: Partial<BoardInput>, max?: number) => boardView(input(over), max).lines.map(l => l.text);

test('nothing pending is an empty board, and no note for the model', () => {
  const view = boardView(input());
  assert.deepEqual(view, { lines: [], more: 0, pending: 0, now: NOW });
  assert.equal(boardNote(view), undefined);
  assert.equal(boardNote(boardView(input({ runs: [run({ state: 'completed', ended: NOW - 11 * MIN })] }))), undefined, 'a worker finished over ten minutes ago is gone');
});

test('a running worker shows its short id, task, elapsed time, tool calls, last tool and model', () => {
  assert.deepEqual(texts({ runs: [run()] }), ['a1b2c3d4 "Fix the flaky wake test" 12m · 31 tools · npm test · claude-sonnet-5-5']);
});

test('a long task, command and output line are cut to their budgets', () => {
  const [w, s] = texts({ runs: [run({ task: 'x'.repeat(200), updated: NOW })], shells: [shell({ command: 'y'.repeat(200), last: 'z'.repeat(200) })] });
  assert.equal(w.match(/"(x+…)"/)![1].length, 40, 'task: 40 characters with the ellipsis');
  assert.equal(s.match(/(y+…)/)![1].length, 40, 'command: 40');
  assert.equal(s.match(/(z+…)/)![1].length, 50, 'last output line: 50');
  assert.equal(toolBrief('bash', { command: 'npm test -- --test-name-pattern "a very long pattern name here"' }).length <= 24, true);
  assert.equal(toolBrief('edit', { path: 'C:\\projetos\\pi-optchat\\src\\agents.ts' }), 'edit agents.ts');
  assert.equal(toolBrief('crew', {}), 'crew');
});

test('elapsed time reads 45s, 4m, 1h05', () => {
  assert.deepEqual([45_000, 4 * MIN + 59_000, 65 * MIN, 0, -5].map(span), ['45s', '4m', '1h05', '0s', '0s']);
});

test('times are Brasília time, whatever the machine zone', () => {
  assert.equal(hhmm(NOW), '13:49');
  assert.equal(hhmm(Date.parse('2026-11-12T02:30:00Z')), '23:30', 'the day before in UTC-3');
});

test('a running shell says it is a shell, then its command, elapsed time, last output line and short id; ANSI and blank lines are dropped', () => {
  assert.deepEqual(texts({ shells: [shell()] }), ['shell npm run verify · 3m · ok 412 - wake recovers · 3f9a1c2e']);
  assert.equal(lastLine('first\n\u001b[32mgreen line\u001b[0m\n\n  \n'), 'green line');
});

test('a shell line drops a leading cd, names the directory instead and says how it ended', () => {
  const cd = 'cd C:/projetos/pi-optchat && grep -n "Inspector" src/index.ts | head -5';
  assert.deepEqual(texts({ shells: [shell({ command: cd, state: 'completed', ended: NOW - MIN, exitCode: 0, last: undefined, id: 'cd8f3ec5-0000' })] }), ['✓ 13:48 shell pi-optchat: grep -n "Inspector" src/index.ts | head… ok · cd8f3ec5']);
  const [quoted, windows, plain, failed, noExit] = texts({ shells: [
    shell({ id: 'aaaaaaaa', command: 'cd "C:\\Users\\x\\my repo\\" && npm test', last: undefined }), shell({ id: 'bbbbbbbb', command: 'cd /d C:\\work\\app; npm run build', last: undefined }),
    shell({ id: 'cccccccc', command: 'cd', last: undefined }),
    shell({ id: 'dddddddd', command: 'npm test', state: 'failed', ended: NOW - MIN, exitCode: 2, last: undefined }), shell({ id: 'eeeeeeee', command: 'npm test', state: 'failed', ended: NOW - MIN, last: undefined })] });
  assert.equal(quoted.startsWith('shell my repo: npm test'), true, quoted);
  assert.equal(windows.startsWith('shell app: npm run build'), true, windows);
  assert.equal(plain.startsWith('shell cd ·'), true, 'a bare cd is left alone');
  assert.equal(failed, '✗ 13:48 shell npm test falhou rc 2 · dddddddd');
  assert.equal(noExit, '✗ 13:48 shell npm test falhou · eeeeeeee');
});

test('a foreground shell is not on the board (the caller filters it) and a stopped one leaves no line', () => {
  assert.deepEqual(texts({ shells: [shell({ state: 'stopped', ended: NOW - MIN })] }), []);
});

test('a parked worker says when it tries again, a paused one says paused, a stopping one says so', () => {
  assert.deepEqual(texts({ runs: [run({ id: 'p1', state: 'interrupted', until: NOW + 31 * MIN, updated: undefined })] }), ['p1 "Fix the flaky wake test" ⏸ cota esgotada, volta às 14:20 · 12m · claude-sonnet-5-5']);
  assert.match(texts({ runs: [run({ id: 'p2', state: 'paused' })] })[0], /^p2 "Fix the flaky wake test" pausado, aguarda você · 12m/);
  assert.match(texts({ runs: [run({ id: 'p3', state: 'stopping' })] })[0], /· parando · 31 tools/);
  assert.deepEqual(texts({ runs: [run({ state: 'interrupted' })] }), [], 'interrupted without a retry time is history');
});

test('a PR in CI shows its repo, number, checks, time pending and auto-merge', () => {
  const gitwatch = { polledAt: NOW - 10_000, prs: [{ repo: 'swlucas05/pi-optchat', number: 280, title: 'x', url: 'u', head: 'h', mergeState: 'CLEAN', autoMerge: true, checks: { pass: 2, fail: 0, pending: 3 }, pendingSince: NOW - 4 * MIN, next: undefined }] };
  assert.deepEqual(texts({ gitwatch }), ['pi-optchat #280 · CI 2/5 · 4m · auto-merge']);
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

test('what waits on the operator is one line, first', () => {
  assert.deepEqual(texts({ waiting: ['aprovar o deploy da 1.4.1'], runs: [run()] })[0], 'aguarda você: aprovar o deploy da 1.4.1');
  assert.equal(texts({ waiting: ['a', 'b', 'c'] })[0], 'aguarda você (3): a');
  assert.equal(boardView(input({ waiting: ['x'.repeat(90)] })).lines[0].text.length, 'aguarda você: '.length + 50);
});

test('finished work stays ten minutes, newest first after the pending lines: workers, shells and gitwatch notices', () => {
  const notices = [{ repo: 'swlucas05/pi-optchat', wake: true, text: 'PR #279 merged', at: NOW - 2 * MIN, events: [{ pr: 279, kind: 'merged', text: 'merged abc1234' }] },
    { repo: 'o/r', at: NOW - 11 * MIN, events: [{ pr: 1, kind: 'merged', text: 'merged' }] },
    { repo: 'o/r', at: new Date(NOW - 3 * MIN).toISOString(), events: [{ pr: 5, kind: 'checks', text: 'checks failed: lint' }, { pr: 5, kind: 'push', text: 'new head f00' }] }];
  const lines = texts({
    runs: [run({ id: 'w1', state: 'completed', ended: NOW - 4 * MIN }), run({ id: 'w2', state: 'failed', ended: NOW - 6 * MIN }), run({ id: 'w3', state: 'running' })],
    shells: [shell({ state: 'completed', ended: NOW - 5 * MIN, exitCode: 0, last: undefined })], notices });
  assert.equal(lines[0].startsWith('w3 "Fix'), true, 'pending first');
  assert.deepEqual(lines.slice(1), [
    '✓ 13:47 pi-optchat #279 mergeado',
    '✗ 13:46 r #5 CI falhou: lint',
    '✓ 13:45 w1 "Fix the flaky wake test" concluído',
    '✓ 13:44 shell npm run verify ok · 3f9a1c2e',
    '✗ 13:43 w2 "Fix the flaky wake test" falhou',
  ]);
});

test('the expanded board keeps each waiting item and each shell whole, with the shell\'s last output line', () => {
  const waiting = ['aprovar o deploy da 1.4.1 em produção depois de conferir o changelog inteiro com a Beatriz', 'decidir X', 'responder o PR #12', 'liberar a cota'];
  const command = 'cd C:/projetos/pi-optchat && grep -n "Inspector" src/index.ts src/navigation.ts src/waiting-board.ts test/navigation.test.ts';
  const inp = input({ waiting, shells: [shell({ command, state: 'completed', ended: NOW - MIN, exitCode: 0, last: 'src/index.ts:93: import { x }' })] });
  const compact = boardView(inp), full = expandedView(inp);
  assert.equal(compact.lines.filter(l => l.tone === 'wait').length, 1, 'compact: one collapsed line');
  assert.equal(compact.lines[0].text, 'aguarda você (4): aprovar o deploy da 1.4.1 em produção depois de c…');
  assert.deepEqual(full.lines.filter(l => l.tone === 'wait').map(l => l.text), waiting.map(w => `aguarda você: ${w}`));
  const sh = full.lines.at(-1)!.text;
  assert.equal(sh, `✓ 13:48 shell pi-optchat: grep -n "Inspector" src/index.ts src/navigation.ts src/waiting-board.ts test/navigation.test.ts ok · 3f9a1c2e\nsaída: src/index.ts:93: import { x }`);
  assert.equal(full.more, 0);
  const many = expandedView(input({ runs: Array.from({ length: 9 }, (_, i) => run({ id: `r${i}` })) }));
  assert.equal(many.lines.length, 9, 'no overflow in the expanded view');
  assert.equal(new WaitingBoard({ runs: () => [], live: () => undefined, shells: () => [], waiting: () => waiting, now: () => NOW }).expanded().lines.length, 4);
});

test('the focused board draws every item wrapped to the width, a cursor on one and the keys that move it', () => {
  const waiting = ['aprovar o deploy da 1.4.1 em produção depois de conferir o changelog inteiro com a Beatriz', 'decidir X', 'responder o PR #12', 'liberar a cota'];
  const view = expandedView(input({ waiting }));
  const lines = renderExpandedBoard(view.lines, 1, 40, (_t, text) => text);
  assert.equal(lines.every(l => visibleWidth(l) <= 40), true);
  assert.equal(lines.filter(l => l.includes('› ')).length, 1);
  assert.equal(lines.find(l => l.includes('› '))!.endsWith('› aguarda você: decidir X'), true, 'the cursor is on the second item');
  const text = lines.map(l => l.slice(2).trim()).join(' ');
  for (const w of waiting) for (const word of w.split(' ')) assert.equal(text.includes(word), true, word);
  assert.equal(lines.at(-1), '│ ↑↓ mover · Esc voltar');
  assert.equal(lines.length > view.lines.length + 1, true, 'the long item wraps onto more rows');
});

test('over the line cap the last line counts what is left and the shortcut inspects it', () => {
  const runs = Array.from({ length: 9 }, (_, i) => run({ id: `r${i}`, updated: NOW - i * 1000 }));
  const view = boardView(input({ runs }));
  assert.equal(view.lines.length, BOARD_LINES - 1);
  assert.equal(view.more, 4);
  assert.deepEqual(view.lines.map(l => l.text.slice(0, 2)), ['r0', 'r1', 'r2', 'r3', 'r4'], 'newest activity first');
  assert.equal(overflowText(view.more, 'F6 inspect'), '+4 mais · F6 inspect');
  assert.equal(boardView(input({ runs: runs.slice(0, 6) })).more, 0, 'exactly the cap fits');
});

test('the board gathers live state: tool counts from the run, background shells only, pi-subagents rows left out', () => {
  const events = new EventEmitter(), emitted: string[] = [];
  const bus = { on: (c: string, h: (d: unknown) => void) => { events.on(c, h); return () => events.off(c, h); }, emit: (c: string, d: unknown) => { emitted.push(c); events.emit(c, d); } };
  const info = (over: Partial<RunInfo>): RunInfo => ({ id: 'a1b2c3d4', task: 'Fix', cwd: '.', model: 'p/m', thinking: 'high', parentSession: 's', started: NOW - MIN, depth: 0, state: 'running', guidance: [], ...over });
  const jobs = [{ id: 'bg-1-xxxxxxxx', command: 'npm test', cwd: '.', mode: 'background', state: 'running', started: NOW - MIN, output: 'a\nb', notify: 'end' }, { id: 'fg', command: 'ls', cwd: '.', mode: 'foreground', state: 'running', started: NOW, output: '', notify: 'end' }] as ShellJob[];
  let waiting = 0, clock = NOW;
  const board = new WaitingBoard({
    runs: () => [info({}), info({ id: 'ext', source: 'pi-subagents' })], live: id => id === 'a1b2c3d4' ? { updated: NOW - 1000, toolCalls: 7, lastTool: { name: 'bash', args: { command: 'npm test' } } } : undefined,
    shells: () => jobs, waiting: () => { waiting++; return ['decidir X']; }, now: () => clock }, bus);
  board.requestState();
  assert.deepEqual(emitted, ['gitwatch:state:request:v1']);
  let redraws = 0; board.subscribe(() => redraws++);
  events.emit('gitwatch:state:v1', { polledAt: NOW, prs: [{ repo: 'o/pi-optchat', number: 280, checks: { pass: 1, fail: 0, pending: 1 }, pendingSince: NOW - 4 * MIN, autoMerge: true }] });
  events.emit('gitwatch:notice:v1', { repo: 'o/pi-optchat', wake: true, text: 'merged', at: NOW - MIN, events: [{ pr: 279, kind: 'merged', text: 'merged' }] });
  events.emit('gitwatch:state:v1', 'garbage');
  assert.equal(redraws, 2, 'each valid event redraws; garbage does not');
  assert.deepEqual(board.view().lines.map(l => l.text), [
    'aguarda você: decidir X', 'a1b2c3d4 "Fix" 1m · 7 tools · npm test · m', 'shell npm test · 1m · b · bg-1-xxx', 'pi-optchat #280 · CI 1/2 · 4m · auto-merge', '✓ 13:48 pi-optchat #279 mergeado']);
  board.view(); board.view();
  assert.equal(waiting, 1, 'the commitments file is read at most once per few seconds');
  clock += 6_000; board.view();
  assert.equal(waiting, 2);
  board.close(); events.emit('gitwatch:state:v1', { prs: [] });
  assert.equal(redraws, 2, 'closed: no more redraws');
});

test('the model\'s note carries the same lines as the widget, minus the finished ones, under 600 characters', () => {
  const view = boardView(input({
    waiting: ['aprovar o deploy da 1.4.1'],
    runs: [run(), run({ id: 'b2c3d4e5', task: 'Review the quota gate diff', last: 'read quota.ts', tools: 8, updated: NOW - 20_000 }), run({ id: 'dead', state: 'completed', ended: NOW - MIN })],
    shells: [shell()], gitwatch: { prs: [{ repo: 'o/pi-optchat', number: 280, checks: { pass: 2, fail: 0, pending: 3 }, pendingSince: NOW - 4 * MIN, autoMerge: true }] } }));
  const note = boardNote(view)!;
  assert.equal(view.lines.some(l => l.finished), true);
  assert.equal(note.length < NOTE_CHARS, true, `${note.length} chars`);
  const pending = view.lines.filter(l => !l.finished).map(l => `- ${l.text}`);
  assert.equal(pending.length, 5);
  assert.deepEqual(note.split('\n').slice(1), pending);
  assert.equal(note.startsWith('13:49 pendente:\n'), true);
  assert.equal(atWork(view), `[OptChat status] ${note}`);
});

test('a note that does not fit says how many lines it left out, and never passes the budget', () => {
  const view = boardView(input({ runs: Array.from({ length: 5 }, (_, i) => run({ id: `r${i}`, task: 'T'.repeat(80), last: 'l'.repeat(24), updated: NOW - i })) }));
  const note = boardNote(view, 300)!;
  assert.equal(note.length <= 300, true, `${note.length}`);
  assert.match(note, /\n\+\d+ mais$/);
  assert.equal(note.split('\n').length - 2 + Number(note.match(/\+(\d+) mais$/)![1]), 5, 'every line is shown or counted');
});

test('the widget draws the board above the editor, coloured by tone, cut to the terminal and counting the overflow', () => {
  const view = boardView(input({ waiting: ['aprovar o deploy'], runs: Array.from({ length: 8 }, (_, i) => run({ id: `r${i}`, updated: NOW - i * 1000 })) }));
  const lines = renderWaitingBoard(view, 60, (tone, text) => `<${tone}>${text}</>`, 'f6');
  assert.equal(lines.length, BOARD_LINES);
  assert.equal(lines[0], '<dim>│ </><warning>aguarda você: aprovar o deploy</>');
  assert.equal(lines.at(-1), '<dim>│ </><dim>+4 mais · f6 inspect</>');
  assert.ok(lines.every(line => visibleWidth(line.replace(/<\/?\w+>/g, '')) <= 60));
  assert.deepEqual(renderWaitingBoard(boardView(input()), 60, (_t, text) => text, 'f6'), [], 'nothing to wait on, no widget');
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
  assert.equal(widget!.render(80).join(''), '│ pi-optchat #280 · CI 2/5 · 4m · auto-merge');
  unmount(); board.close(); mock.timers.reset();
  assert.equal(widgets.size, 0);
});

test('mounted, the widget keeps the compact look until the board is focused, then lists every item and goes back on Esc', () => {
  const waiting = ['aprovar o deploy', 'decidir X', 'responder o PR #12', 'liberar a cota'];
  const board = new WaitingBoard({ runs: () => [], live: () => undefined, shells: () => [], waiting: () => waiting, now: () => NOW });
  const nav = new BoardNavigation(board); let widget: { render(width: number): string[] } | undefined;
  const ctx = { ui: { setWidget: (_key: string, factory?: (tui: unknown, theme: unknown) => { render(width: number): string[] }) => { if (factory) widget = factory({ requestRender: () => {} }, { fg: (_tone: string, text: string) => text }); } } };
  mock.timers.enable({ apis: ['setInterval'] });
  const unmount = mountWaitingBoard(ctx as unknown as ExtensionContext, board, 'f6', nav);
  assert.deepEqual(widget!.render(80), ['│ aguarda você (4): aprovar o deploy']);
  nav.handle('\x1b[A', true, false);
  assert.deepEqual(widget!.render(80), ['│ › aguarda você: aprovar o deploy', '│   aguarda você: decidir X', '│   aguarda você: responder o PR #12', '│   aguarda você: liberar a cota', '│ ↑↓ mover · Esc voltar']);
  nav.handle('\x1b', true, false);
  assert.deepEqual(widget!.render(80), ['│ aguarda você (4): aprovar o deploy']);
  unmount(); board.close(); mock.timers.reset();
});
