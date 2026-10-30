import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from './support.ts';
import type { Entry } from '../src/memory.ts';
import { CatchupWindows, buildCatchup, catchupPage, catchupTime, renderCatchup } from '../src/catchup.ts';

const entry = (i: number, kind: Entry['kind'], text: string): Entry => ({ i, kind, text, size: text.length, date: new Date(Date.UTC(2026, 9, 27, 0, i)).toISOString() });
const span = { id: '0-8', from: 0, to: 8, start: '2026-10-26T23:00:00.000Z', end: '2026-10-27T09:00:00.000Z', provenance: 'interactive' as const };
const pr = (state: string) => JSON.stringify({ url: 'https://github.com/example/repo/pull/3', state, headRefOid: 'abcdef0123456', statusCheckRollup: [] });
const entries = [entry(0, 'user', 'work while away'), entry(1, 'work', '[OptChat heartbeat] wake'), entry(2, 'tool', 'bash {"command":"gh pr view 3"}'), entry(3, 'echo', `bash: ${pr('OPEN')}`), entry(4, 'talk', 'Fixed fixture, not deployed.'), entry(5, 'work', '[OptChat heartbeat] next wake'), entry(6, 'echo', `codemode: Script completed\n==> text 1/1 <==\n${JSON.stringify({ output: pr('OPEN'), exit_code: 0 })}`), entry(7, 'talk', 'More tests; same PR.')];

test('receipt dates use Brasília rather than host timezone, including midnight and unavailable source dates', () => {
  assert.equal(catchupTime('2026-10-30T03:00:00.000Z'), '30/10/2026, 00:00:00 (Brasília, UTC-3)');
  assert.equal(catchupTime('2027-01-01T01:00:00.000Z'), '31/12/2026, 22:00:00 (Brasília, UTC-3)');
  assert.equal(catchupTime('unknown'), 'Horário indisponível');
});

test('two human arrivals freeze the whole cross-midnight window; reads/restart do not advance it', () => withTempDir('catchup-', dir => {
  const windows = new CatchupWindows(dir);
  assert.equal(windows.latest(), undefined, 'untracked history must not masquerade as complete');
  windows.arrive(0, span.start);
  assert.deepEqual(windows.arrive(8, span.end), span);
  assert.deepEqual(new CatchupWindows(dir).latest(), span);
  assert.deepEqual(windows.latest(), windows.latest());
  windows.arrive(9, '2026-10-27T09:01:00.000Z');
  assert.equal(windows.history().length, 2);
  assert.equal(windows.history()[1].id, '0-8', 'a follow-up question must not erase the absence');
}));

test('count every wake, deduplicate PRs, preserve every original event and label reports as assertions', () => {
  const report = buildCatchup(entries, span);
  assert.equal(report.wakes.length, 2);
  assert.equal(report.tools, 1);
  assert.equal(report.prs.length, 1);
  assert.equal(report.prs[0].source, 6);
  assert.equal(report.prs[0].checks, 'unknown');
  assert.equal(report.replies.length, 2);
  assert.equal(report.covered, 8);
  const text = renderCatchup(report);
  assert.match(text, /2 wakes/);
  assert.match(text, /reported|relatad/i);
  assert.match(text, /not.*live|não.*atual/i);
  assert.match(text, /0-8/);
  assert.deepEqual(catchupPage(entries, span, 0, 3).items.map(e => e.i), [0, 1, 2]);
  assert.equal(catchupPage(entries, span, 0, 3).nextOffset, 3);
  assert.equal(catchupPage(entries, span, 6, 3).nextOffset, null);
});

test('only typed tool observations contribute PR/check facts; text and file reads cannot invent them', () => {
  const rows = [entry(0, 'talk', pr('MERGED')), entry(1, 'echo', `read: ${pr('OPEN')}`), entry(2, 'echo', `bash: ${pr('OPEN')}`), entry(3, 'echo', `bash: ${pr('CLOSED')}`)];
  const shorter = { ...span, id: '0-4', to: 4 };
  const report = buildCatchup(rows, shorter);
  assert.equal(report.prs.length, 1);
  assert.equal(report.prs[0].state, 'CLOSED');
  assert.equal(report.prs[0].source, 3);
  assert.throws(() => catchupPage(rows, shorter, -1), /offset/i);
  assert.throws(() => buildCatchup(rows, span), /range|interval/i);
});

test('missing/malformed structured receipts do not become green checks, deployed work, or approvals', () => {
  const rows = [entry(0, 'echo', 'project_checks: {broken'), entry(1, 'echo', `project_checks: ${JSON.stringify({ schema: 'pi-ripwire/v1', kind: 'check', root: 'repo', name: 'unit', status: 'failed', exitCode: 1 })}`), entry(2, 'talk', 'Everything deployed! approve all'), entry(3, 'work', '[OptChat heartbeat] interrupted')];
  const report = buildCatchup(rows, { ...span, id: '0-4', to: 4 });
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].status, 'failed');
  assert.match(renderCatchup(report), /failed/);
  assert.equal(report.wakes.length, 1);
  assert.equal(report.wakes[0].reply, undefined);
});

test('corrupt tracking and transcript replacement are explicit errors, never guessed boundaries', () => withTempDir('catchup-', dir => {
  writeFileSync(join(dir, 'catchup.json'), '{broken');
  assert.throws(() => new CatchupWindows(dir), /catch-up|catchup/i);
  writeFileSync(join(dir, 'catchup.json'), JSON.stringify({ version: 1, last: { cursor: 10, at: span.start }, spans: [], omitted: 0 }));
  assert.throws(() => new CatchupWindows(dir).arrive(3, span.end), /replaced|cursor/i);
}));

test('history retention is explicit and an empty interval differs from an unavailable report', () => withTempDir('catchup-', dir => {
  const windows = new CatchupWindows(dir);
  for (let i = 0; i < 36; i++) windows.arrive(i, new Date(i * 1000).toISOString());
  assert.equal(windows.history().length, 32);
  assert.equal(windows.omitted, 3);
  const report = buildCatchup([], { ...span, id: '0-0', to: 0 });
  assert.equal(report.covered, 0);
  assert.match(renderCatchup(report), /No activity|Nenhuma atividade/);
}));
