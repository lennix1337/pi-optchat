import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_IDEAS,
  addIdea,
  approveIdeas,
  board,
  formatIdeaList,
  formatIdeasBoard,
  ideaId,
  ideasConfig,
  ideasSummary,
  ideasTool,
  ideasWakeReasons,
  invalidIdeas,
  numbered,
  readIdeas,
  stale,
  todayProposed,
  updateIdea,
} from '../src/ideas.ts';
import { composeSummary, localInputs } from '../src/slack-reports.ts';
import { HEARTBEAT_PROMPT, Heartbeat, beatSnapshot } from '../src/heartbeat.ts';
import { defaults, loadConfig } from '../src/profiles.ts';
import { removeDir } from './support.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'optchat-ideas-'));
const localMs = (y: number, m: number, d: number, hh: number, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();

test('addIdea deduplicates same day+title and assigns deterministic sha256 idea_<8hex> id', () => {
  const dir = temp();
  try {
    const t1 = localMs(2026, 4, 10, 9, 0);
    const first = addIdea(dir, {
      day: '2026-04-10',
      title: 'Cache API metadata',
      why: 'Cuts cold startup latency by 40%',
      repo: 'acme/api',
      effort: 'S',
    }, t1);
    const second = addIdea(dir, {
      day: '2026-04-10',
      title: '  Cache API metadata  ',
      why: 'Different explanation should be ignored on dedupe',
      repo: 'acme/api',
      effort: 'M',
    }, t1 + 60_000);

    assert.equal(first.added, true);
    assert.equal(second.added, false);
    assert.match(first.row.id, /^idea_[0-9a-f]{8}$/);
    assert.equal(first.row.id, ideaId('2026-04-10', 'Cache API metadata'));
    assert.equal(second.row.id, first.row.id);
    assert.equal(readIdeas(dir).length, 1);

    const nextDay = addIdea(dir, {
      day: '2026-04-11',
      title: 'Cache API metadata',
      why: 'Next day is a distinct id',
      repo: 'acme/api',
      effort: 'S',
    }, t1 + 86_400_000);
    assert.equal(nextDay.added, true);
    assert.notEqual(nextDay.row.id, first.row.id);
    assert.equal(readIdeas(dir).length, 2);
  } finally { removeDir(dir); }
});

test('board collapses append-only rows so latest row per id wins', () => {
  const dir = temp();
  try {
    const t0 = localMs(2026, 4, 10, 10, 0);
    const { row } = addIdea(dir, {
      day: '2026-04-10',
      title: 'Add retry jitter',
      why: 'Avoids synchronized spikes after upstream blips',
      repo: 'acme/worker',
      effort: 'M',
    }, t0);
    approveIdeas(dir, '2026-04-10', [1], t0 + 1_000);
    updateIdea(dir, { id: row.id, status: 'doing', worker: 'run_42', note: 'started' }, t0 + 2_000);
    updateIdea(dir, { id: row.id, status: 'done', pr: 'https://github.com/acme/worker/pull/18', note: 'merged' }, t0 + 3_000);

    const rows = readIdeas(dir);
    assert.equal(rows.length, 4);
    const current = board(rows);
    assert.equal(current.length, 1);
    assert.equal(current[0]!.status, 'done');
    assert.equal(current[0]!.worker, 'run_42');
    assert.equal(current[0]!.pr, 'https://github.com/acme/worker/pull/18');
    assert.equal(current[0]!.note, 'merged');
    assert.equal(todayProposed(rows, '2026-04-10').length, 0);
  } finally { removeDir(dir); }
});

test('numbered keeps stable 1..N ordering per day across other days and status updates', () => {
  const dir = temp();
  try {
    const d1 = '2026-04-10';
    const d2 = '2026-04-11';
    const a = addIdea(dir, { day: d1, title: 'Second by insertion, first by time', why: 'gain 1', repo: 'acme/a', effort: 'S' }, localMs(2026, 4, 10, 9, 30)).row;
    const b = addIdea(dir, { day: d1, title: 'Earlier timestamp', why: 'gain 2', repo: 'acme/a', effort: 'M' }, localMs(2026, 4, 10, 9, 0)).row;
    const c = addIdea(dir, { day: d1, title: 'Third idea', why: 'gain 3', repo: '', effort: 'L' }, localMs(2026, 4, 10, 10, 0)).row;

    addIdea(dir, { day: d2, title: 'Day two idea', why: 'gain 4', repo: 'acme/b', effort: 'S' }, localMs(2026, 4, 11, 8, 0));

    const before = numbered(readIdeas(dir), d1);
    assert.deepEqual(before.map(x => [x.number, x.id]), [[1, b.id], [2, a.id], [3, c.id]]);

    approveIdeas(dir, d1, [1], localMs(2026, 4, 11, 7, 15));
    updateIdea(dir, { id: b.id, status: 'doing', worker: 'shell_7' }, localMs(2026, 4, 11, 7, 30));

    const after = numbered(readIdeas(dir), d1);
    assert.deepEqual(after.map(x => [x.number, x.id, x.status]), [
      [1, b.id, 'doing'],
      [2, a.id, 'proposed'],
      [3, c.id, 'proposed'],
    ]);
    assert.deepEqual(numbered(readIdeas(dir), d2).map(x => [x.number, x.title]), [[1, 'Day two idea']]);
  } finally { removeDir(dir); }
});

test('ideas tool approves by numbers, lists compact lines, and refuses invalid numbers without partial writes', async () => {
  const dir = temp();
  try {
    let now = localMs(2026, 4, 10, 9, 0);
    const tool = ideasTool(() => ({ dir }), () => now);
    await tool.execute('1', { action: 'add', day: '2026-04-10', title: 'Idea one', why: 'gain one', repo: 'acme/web', effort: 'S' });
    now += 1_000;
    await tool.execute('2', { action: 'add', day: '2026-04-10', title: 'Idea two', why: 'gain two', repo: 'acme/api', effort: 'M' });
    now += 1_000;
    await tool.execute('3', { action: 'add', day: '2026-04-10', title: 'Idea three', why: 'gain three', repo: '', effort: 'L' });

    await assert.rejects(tool.execute('4', { action: 'approve', day: '2026-04-10', numbers: [1, 99] }), /#99/);
    assert.equal(board(readIdeas(dir)).filter(r => r.status === 'approved').length, 0, 'invalid batch must write nothing');

    now += 5_000;
    await tool.execute('5', { action: 'approve', day: '2026-04-10', numbers: [1, 3] });

    const approvedList = await tool.execute('6', { action: 'list', status: 'approved', day: '2026-04-10' });
    const text = approvedList.content[0]!.type === 'text' ? approvedList.content[0]!.text : '';
    const lines = text.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^#1 \[approved\] Idea one \(acme\/web, S\) idea_[0-9a-f]{8}$/);
    assert.match(lines[1]!, /^#3 \[approved\] Idea three \(L\) idea_[0-9a-f]{8}$/);

    const proposedList = formatIdeaList(readIdeas(dir), { status: 'proposed', day: '2026-04-10' });
    assert.match(proposedList, /^#2 \[proposed\] Idea two \(acme\/api, M\) idea_[0-9a-f]{8}$/);
  } finally { removeDir(dir); }
});

test('transition guards refuse done without GitHub PR/commit URL and doing without worker', () => {
  const dir = temp();
  try {
    const t0 = localMs(2026, 4, 10, 10, 0);
    const { row } = addIdea(dir, {
      day: '2026-04-10',
      title: 'Trim query payload',
      why: 'Reduces bandwidth by 25%',
      repo: 'acme/api',
      effort: 'S',
    }, t0);

    assert.throws(() => updateIdea(dir, { id: row.id, status: 'doing' }, t0 + 1_000), /worker/);
    assert.throws(() => updateIdea(dir, { id: row.id, status: 'done' }, t0 + 1_000), /GitHub PR or commit URL/);
    assert.throws(() => updateIdea(dir, { id: row.id, status: 'done', pr: 'https://example.com/pull/1' }, t0 + 1_000), /GitHub PR or commit URL/);
    assert.throws(() => addIdea(dir, { day: '2026-04-10', title: 'x'.repeat(121), why: 'ok', repo: '', effort: 'S' }), /120/);
    assert.throws(() => addIdea(dir, { day: '2026-04-10', title: 'ok', why: 'y'.repeat(301), repo: '', effort: 'S' }), /300/);
    assert.throws(() => addIdea(dir, { day: '2026-04-10', title: 'ok', why: 'ok', repo: '../escape', effort: 'S' }), /repo/);
    assert.equal(readIdeas(dir).length, 1, 'refused writes must not append');

    const doing = updateIdea(dir, { id: row.id, status: 'doing', worker: 'w_101' }, t0 + 2_000);
    assert.equal(doing.worker, 'w_101');
    const done = updateIdea(dir, { id: row.id, status: 'done', pr: 'https://github.com/acme/api/commit/abcdef12' }, t0 + 3_000);
    assert.equal(done.status, 'done');
    assert.equal(done.pr, 'https://github.com/acme/api/commit/abcdef12');
  } finally { removeDir(dir); }
});

test('stale detects doing ideas older than threshold and ignores refreshed or non-doing ideas', () => {
  const dir = temp();
  try {
    const start = localMs(2026, 4, 10, 10, 0);
    const oldDoing = addIdea(dir, { day: '2026-04-10', title: 'Stuck worker', why: 'gain', repo: 'acme/a', effort: 'M' }, start).row;
    const freshDoing = addIdea(dir, { day: '2026-04-10', title: 'Active worker', why: 'gain', repo: 'acme/a', effort: 'S' }, start).row;
    const approvedOld = addIdea(dir, { day: '2026-04-10', title: 'Waiting approval', why: 'gain', repo: 'acme/a', effort: 'S' }, start).row;
    const doneOld = addIdea(dir, { day: '2026-04-10', title: 'Finished work', why: 'gain', repo: 'acme/a', effort: 'S' }, start).row;

    updateIdea(dir, { id: oldDoing.id, status: 'doing', worker: 'run_old' }, start);
    updateIdea(dir, { id: freshDoing.id, status: 'doing', worker: 'run_fresh' }, start);
    updateIdea(dir, { id: approvedOld.id, status: 'approved' }, start);
    updateIdea(dir, { id: doneOld.id, status: 'done', pr: 'https://github.com/acme/a/pull/9' }, start);

    const checkAt = start + 2 * 3_600_000 + 60_000;
    updateIdea(dir, { id: freshDoing.id, status: 'doing', note: 'still progressing' }, checkAt - 30 * 60_000);

    const rows = readIdeas(dir);
    const found = stale(rows, checkAt, 2);
    assert.deepEqual(found.map(r => r.id), [oldDoing.id]);
    assert.equal(stale(rows, start + 2 * 3_600_000, 2).length, 0, 'exact 2h boundary is not yet older than 2h');
  } finally { removeDir(dir); }
});

test('composeSummary omits Ideias de ontem on empty board and renders capped numbered section with counts when populated', () => {
  const dir = temp();
  try {
    const morning = localMs(2026, 4, 11, 7, 5);
    const emptyText = composeSummary({ ...localInputs(dir, morning, []), waiting: [], approvals: 0 });
    assert.doesNotMatch(emptyText, /Ideias de ontem/);
    assert.doesNotMatch(emptyText, /Responda com os números/);

    const yesterday = '2026-04-10';
    const yBase = localMs(2026, 4, 10, 9, 0);
    for (let i = 1; i <= 32; i++) {
      addIdea(dir, {
        day: yesterday,
        title: `Proposal ${i}`,
        why: `Measurable gain ${i}`,
        repo: 'acme/app',
        effort: i % 3 === 0 ? 'L' : i % 2 === 0 ? 'M' : 'S',
      }, yBase + i * 1_000);
    }
    const doneRow = addIdea(dir, {
      day: '2026-04-09',
      title: 'Shipped yesterday',
      why: 'Already merged',
      repo: 'acme/app',
      effort: 'S',
    }, localMs(2026, 4, 9, 10, 0)).row;
    updateIdea(dir, { id: doneRow.id, status: 'done', pr: 'https://github.com/acme/app/pull/55' }, localMs(2026, 4, 10, 16, 0));

    const approvedRow = addIdea(dir, {
      day: '2026-04-09',
      title: 'Approved waiting dispatch',
      why: 'Ready to run',
      repo: 'acme/app',
      effort: 'M',
    }, localMs(2026, 4, 9, 11, 0)).row;
    updateIdea(dir, { id: approvedRow.id, status: 'approved' }, localMs(2026, 4, 10, 8, 0));

    const staleRow = addIdea(dir, {
      day: '2026-04-09',
      title: 'Stale in flight',
      why: 'Worker silent',
      repo: 'acme/app',
      effort: 'L',
    }, localMs(2026, 4, 9, 12, 0)).row;
    updateIdea(dir, { id: staleRow.id, status: 'doing', worker: 'run_stale' }, morning - 3 * 3_600_000);

    const summary = ideasSummary(readIdeas(dir), morning, 2);
    assert.ok(summary);
    assert.equal(summary.proposed.length, 30, 'yesterday proposals capped at 30');
    assert.equal(summary.approved, 1);
    assert.equal(summary.doing, 1);
    assert.equal(summary.doneYesterday.length, 1);
    assert.equal(summary.stale, 1);

    const text = composeSummary({ ...localInputs(dir, morning, []), waiting: [], approvals: 0 });
    assert.match(text, /\*Ideias de ontem\*/);
    assert.match(text, /1\. Proposal 1 · acme\/app · S/);
    assert.match(text, /30\. Proposal 30 · acme\/app · L/);
    assert.doesNotMatch(text, /31\. Proposal 31/);
    assert.match(text, /https:\/\/github\.com\/acme\/app\/pull\/55/);
    assert.match(text, /Paradas há mais de 2 h: 1/);
    assert.match(text, /Responda com os números \(ex\.: 1, 4, 7\) para eu implementar hoje\./);
  } finally { removeDir(dir); }
});

test('config validation enforces neutral ideas defaults and rejects invalid values', () => {
  assert.deepEqual(DEFAULT_IDEAS, { dailyTarget: 0, staleHours: 2 });
  assert.equal(invalidIdeas(undefined), undefined);
  assert.equal(invalidIdeas({ dailyTarget: 30, staleHours: 2 }), undefined);
  assert.ok(invalidIdeas({ dailyTarget: -1 }));
  assert.ok(invalidIdeas({ staleHours: 0 }));
  assert.ok(invalidIdeas({ extra: true }));

  const dir = temp();
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      compactor: defaults.compactor,
      subagent: defaults.subagent,
      ideas: { dailyTarget: 30, staleHours: 2 },
    }));
    const loaded = loadConfig(dir);
    assert.deepEqual(ideasConfig(loaded), { dailyTarget: 30, staleHours: 2 });

    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      compactor: defaults.compactor,
      subagent: defaults.subagent,
      ideas: { dailyTarget: 'thirty' },
    }));
    assert.throws(() => loadConfig(dir), /ideas/);
  } finally { removeDir(dir); }
});

test('heartbeat verdict input and WAKE triggers cover approved-not-dispatched, stale doing, and daily proposal window', async () => {
  assert.match(HEARTBEAT_PROMPT, /approved idea on the ideas board/i);
  assert.match(HEARTBEAT_PROMPT, /doing idea on the ideas board/i);
  assert.match(HEARTBEAT_PROMPT, /08:00 and 22:00/);

  const dir = temp();
  try {
    const nightAt = localMs(2026, 4, 10, 23, 0);
    const dayAt = localMs(2026, 4, 10, 14, 0);
    const enabled = { dailyTarget: 30, staleHours: 2 };

    const { row } = addIdea(dir, {
      day: '2026-04-09',
      title: 'Dispatch approved pipeline item',
      why: 'Saves 15 min per deploy',
      repo: 'acme/app',
      effort: 'M',
    }, localMs(2026, 4, 9, 15, 0));
    updateIdea(dir, { id: row.id, status: 'approved' }, localMs(2026, 4, 10, 8, 0));

    const rows = readIdeas(dir);
    assert.deepEqual(ideasWakeReasons(rows, DEFAULT_IDEAS, dayAt), [], 'dailyTarget 0 disables ideas wake reasons');
    assert.equal(formatIdeasBoard(rows, DEFAULT_IDEAS, dayAt), '');

    const nightReasons = ideasWakeReasons(rows, enabled, nightAt);
    assert.equal(nightReasons.length, 1);
    assert.match(nightReasons[0]!, /approved idea not yet dispatched/i);
    assert.ok(nightReasons[0]!.includes(row.id));

    const dayReasons = ideasWakeReasons(rows, enabled, dayAt);
    assert.equal(dayReasons.length, 2);
    assert.ok(dayReasons.some(r => /below daily target \(0\/30/i.test(r)));

    const boardText = formatIdeasBoard(rows, enabled, nightAt);
    const snapshot = beatSnapshot({ view: 'v', state: '', idleMinutes: 15, agents: [], shells: [], ideas: boardText });
    assert.match(snapshot, /Ideas board/);
    assert.match(snapshot, /Approved \(not yet dispatched\)/);
    assert.ok(snapshot.includes(row.id));

    let timer: (() => void) | undefined;
    const woken: string[] = [];
    const beat = new Heartbeat({
      dir,
      now: () => nightAt,
      minutes: () => 15,
      maxWakes: () => 10,
      always: () => false,
      busy: () => undefined,
      ideas: () => enabled,
      check: async () => ({ wake: false, text: 'model would sleep' }),
      wake: b => { woken.push(b.text); },
      note: () => {},
      setTimer: run => { timer = run; return 1; },
      clearTimer: () => { timer = undefined; },
    });
    beat.arm();
    timer!();
    await beat.settled();
    assert.equal(woken.length, 1, 'approved-not-dispatched idea wakes heartbeat without waiting on cheap check');
    assert.match(woken[0]!, /approved idea not yet dispatched/i);

    const wokenOff: string[] = [];
    const beatOff = new Heartbeat({
      dir,
      now: () => nightAt,
      minutes: () => 15,
      maxWakes: () => 10,
      always: () => false,
      busy: () => undefined,
      ideas: () => DEFAULT_IDEAS,
      check: async () => ({ wake: false, text: 'quiet' }),
      wake: b => { wokenOff.push(b.text); },
      note: () => {},
      setTimer: run => { timer = run; return 1; },
      clearTimer: () => { timer = undefined; },
    });
    beatOff.arm();
    timer!();
    await beatOff.settled();
    assert.deepEqual(wokenOff, [], 'dailyTarget 0 leaves heartbeat asleep');

    updateIdea(dir, { id: row.id, status: 'doing', worker: 'run_silent' }, nightAt - 3 * 3_600_000);
    const staleReasons = ideasWakeReasons(readIdeas(dir), enabled, nightAt);
    assert.equal(staleReasons.length, 1);
    assert.match(staleReasons[0]!, /doing idea stale > 2 h/i);
    assert.ok(staleReasons[0]!.includes('run_silent'));
  } finally { removeDir(dir); }
});
