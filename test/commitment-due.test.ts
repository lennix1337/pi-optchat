import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dueFindings, escalationLine, nextDue, overdueDay, OVERDUE_MS, type DueItem, type DueState } from '../src/commitment-due.ts';
import { addCommitment, commitmentsContext, commitmentsTool, readCommitments } from '../src/commitments.ts';

const T0 = Date.parse('2026-11-10T12:00:00Z');
const HOUR = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
const item = (extra: Partial<DueItem> = {}): DueItem => ({ id: 'c_aaaaaa', text: 'ship the thing', owner: 'optchat', status: 'open', due: iso(T0), ...extra });
const fresh = (): DueState => ({ dueSeen: [], escalated: {} });

test('a due time that passed signals once, with the id and text; the project is its project field, else global', () => {
  const items = [item(), item({ id: 'c_bbbbbb', text: 'other', project: 'dentai', due: iso(T0 + 5 * 60_000) })];
  const first = dueFindings(items, fresh(), T0 + 10 * 60_000);
  assert.deepEqual(first.findings.map(f => [f.project, f.line]), [['global', 'commitment due: c_aaaaaa ship the thing'], ['dentai', 'commitment due: c_bbbbbb other']]);
  const again = dueFindings(items, first.state, T0 + 25 * 60_000);
  assert.deepEqual(again.findings, [], 'consumed: the next tick says nothing');
  const moved = dueFindings([item({ due: iso(T0 + 60 * 60_000) })], again.state, T0 + 70 * 60_000);
  assert.equal(moved.findings.length, 1, 'a new due time is a new due');
});

test('an item not yet due, a closed one and an operator-owned one signal nothing', () => {
  const items = [item({ due: iso(T0 + HOUR) }), item({ id: 'c_cccccc', status: 'done' }), item({ id: 'c_dddddd', owner: 'operator', status: 'waiting_operator' })];
  assert.deepEqual(dueFindings(items, fresh(), T0 + 30 * 60_000).findings, []);
  assert.deepEqual(dueFindings(items.slice(1), fresh(), T0 + 2 * OVERDUE_MS).findings, []);
});

test('overdue 24 h: the escalation signal replaces the due line, at most once per 24 h', () => {
  const now = T0 + OVERDUE_MS + 60_000;
  const first = dueFindings([item()], fresh(), now);
  assert.deepEqual(first.findings.map(f => [f.kind, f.line]), [['overdue', escalationLine('c_aaaaaa')]]);
  assert.match(first.findings[0]!.line, /^overdue 24h\+: c_aaaaaa - close it with evidence, narrow it \(new due \+ next\), or make it a direct question to the operator \(status waiting_operator with choices\)$/);
  assert.deepEqual(dueFindings([item()], first.state, now + 23 * HOUR).findings, [], 'not again within 24 h');
  const next = dueFindings([item()], first.state, now + 24 * HOUR);
  assert.deepEqual(next.findings.map(f => f.kind), ['overdue'], 'a day after the last escalation it is due again');
  assert.equal(next.state.escalated.c_aaaaaa, now + 24 * HOUR);
});

test('a state that was not kept (the tick did not settle) escalates again; closing the item drops its state', () => {
  const now = T0 + 2 * OVERDUE_MS;
  assert.equal(dueFindings([item()], fresh(), now).findings.length, 1);
  assert.equal(dueFindings([item()], fresh(), now + 60_000).findings.length, 1);
  const kept = dueFindings([item()], fresh(), now).state;
  const gone = dueFindings([item({ status: 'done' })], kept, now + HOUR).state;
  assert.deepEqual(gone, { dueSeen: [], escalated: {} });
});

test('waiting_operator with choices is exempt from the 24 h rule; without choices it is not; blocked is not', () => {
  const now = T0 + 3 * OVERDUE_MS;
  assert.equal(overdueDay(item({ status: 'waiting_operator', choices: ['yes', 'no'] }), now), false);
  assert.equal(overdueDay(item({ status: 'waiting_operator' }), now), true);
  assert.equal(overdueDay(item({ status: 'blocked' }), now), true);
  assert.equal(overdueDay(item(), T0 + OVERDUE_MS - 1), false);
  assert.equal(overdueDay(item(), T0 + OVERDUE_MS), true);
  const asked = dueFindings([item({ status: 'waiting_operator', choices: ['yes'] })], fresh(), now);
  assert.deepEqual(asked.findings.map(f => f.kind), ['due'], 'only its one due line, never the escalation');
});

test('the next due is the soonest open future one', () => {
  const items = [item({ due: iso(T0 + 3 * HOUR) }), item({ id: 'c_2', due: iso(T0 + HOUR) }), item({ id: 'c_3', due: iso(T0 - HOUR) }), item({ id: 'c_4', status: 'done', due: iso(T0 + 1000) }), item({ id: 'c_5' }), item({ id: 'c_6', due: undefined })];
  assert.equal(nextDue(items, T0), T0 + HOUR);
  assert.equal(nextDue(items.slice(2), T0 + 4 * HOUR), undefined);
});

const temp = () => mkdtempSync(join(tmpdir(), 'due-'));
const toolOf = (dir: string) => commitmentsTool(() => ({ dir, sourceExists: () => true }));
const run = (dir: string, args: Record<string, unknown>) => toolOf(dir).execute('t', args as never);

/** A commitment whose due passed `hours` ago. */
function overdueItem(dir: string, hours: number, extra: Record<string, unknown> = {}) {
  const real = Date.now;
  const c = addCommitment(dir, { text: 'stuck thing', source: '1', next: 'wait', dueInMinutes: 1, ...extra }, real() - hours * HOUR - 120_000);
  return c;
}

test('the turn block marks an item overdue 24 h+ with the rule; a fresher overdue one only with OVERDUE', () => {
  const dir = temp();
  try {
    const late = overdueItem(dir, 30), recent = overdueItem(dir, 2);
    const block = commitmentsContext(readCommitments(dir), Date.now());
    const lateLine = block.split('\n').find(l => l.includes(late.id))!, recentLine = block.split('\n').find(l => l.includes(recent.id))!;
    assert.match(lateLine, /overdue 24h\+: close it with evidence, narrow it \(new due \+ next\), or make it a direct question to the operator \(status waiting_operator with choices\)/);
    assert.doesNotMatch(recentLine, /overdue 24h\+/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an update on an item overdue 24 h+ is refused unless it closes, changes status, sets a future due, or sets choices', async () => {
  const dir = temp();
  try {
    const c = overdueItem(dir, 30);
    await assert.rejects(run(dir, { action: 'update', id: c.id, progress: 'still waiting' }), /overdue .*close it with evidence.*narrow it.*direct question/s);
    await assert.rejects(run(dir, { action: 'update', id: c.id, next: 'wait more' }), /narrow it/);
    await assert.rejects(run(dir, { action: 'update', id: c.id, status: 'open', progress: 'same status' }), /narrow it/);
    await assert.rejects(run(dir, { action: 'update', id: c.id, dueInMinutes: -5 }), /positive|narrow it/);
    await assert.rejects(run(dir, { action: 'update', id: c.id, due: iso(Date.now() - HOUR) }), /narrow it/, 'a due in the past does not narrow it');
    assert.equal(readCommitments(dir)[0]!.notes.length, 0, 'nothing was written by the refusals');
    await run(dir, { action: 'update', id: c.id, dueInMinutes: 60, next: 'check CI at the new due' });
    assert.ok(Date.parse(readCommitments(dir)[0]!.due!) > Date.now(), 'a future due is allowed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('each allowed move on an item overdue 24 h+ goes through', async () => {
  const dir = temp();
  try {
    const done = overdueItem(dir, 30), dropped = overdueItem(dir, 30), blocked = overdueItem(dir, 30), asked = overdueItem(dir, 30);
    await run(dir, { action: 'update', id: done.id, status: 'done', evidence: 'gh pr view: MERGED' });
    await run(dir, { action: 'update', id: dropped.id, status: 'dropped' });
    await run(dir, { action: 'update', id: blocked.id, status: 'blocked', progress: 'needs the key' });
    await run(dir, { action: 'update', id: asked.id, choices: ['go', 'stop'], status: 'waiting_operator' });
    const by = Object.fromEntries(readCommitments(dir).map(c => [c.id, c]));
    assert.deepEqual([by[done.id]!.status, by[dropped.id]!.status, by[blocked.id]!.status, by[asked.id]!.status], ['done', 'dropped', 'blocked', 'waiting_operator']);
    assert.deepEqual(by[asked.id]!.choices, ['go', 'stop']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('choices alone on an overdue open item is allowed, and a waiting_operator item with choices takes progress updates', async () => {
  const dir = temp();
  try {
    const c = overdueItem(dir, 30);
    await run(dir, { action: 'update', id: c.id, choices: ['a'] });
    await run(dir, { action: 'update', id: c.id, status: 'waiting_operator' });
    await run(dir, { action: 'update', id: c.id, progress: 'asked him on Slack' });
    assert.equal(readCommitments(dir)[0]!.notes.length, 1, 'exempt: a plain progress note is accepted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an item overdue less than 24 h and an update with no overdue keep working as before', async () => {
  const dir = temp();
  try {
    const c = overdueItem(dir, 5);
    await run(dir, { action: 'update', id: c.id, progress: 'checked, still red' });
    assert.equal(readCommitments(dir)[0]!.notes.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
