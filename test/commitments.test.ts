import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCommitment, commitmentsContext, commitmentsTool, Presence, PRESENCE_REPORT_MS, PRESENCE_STALL_MS, readCommitments, registerCommitments, STALE_MS, summaryLines, updateCommitment } from '../src/commitments.ts';
import { composeSummary } from '../src/slack-reports.ts';
import { plainToolResult } from './support.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'commitments-'));
const T0 = Date.parse('2026-10-30T21:00:00Z'); // 18:00 in Brasília

test('a commitment is added, shown in the turn block with age and deadline in UTC-3, and closed only with evidence', () => {
  const dir = temp();
  try {
    const c = addCommitment(dir, { text: 'Merge PR #31 after CI', source: '91900', next: 'wait CI', dueInMinutes: 90 }, T0);
    assert.match(c.id, /^c_[0-9a-f]{6}$/);
    const block = commitmentsContext(readCommitments(dir), T0 + 30 * 60_000);
    assert.match(block, /Open commitments \(1/);
    assert.match(block, new RegExp(`${c.id} \\[optchat · open · 30m old, due 19:30 \\(in 1h\\)\\] Merge PR #31 after CI — next: wait CI`));
    assert.throws(() => updateCommitment(dir, { id: c.id, status: 'done' }, T0), /needs evidence/);
    updateCommitment(dir, { id: c.id, status: 'done', evidence: 'gh pr view 31: MERGED abc123' }, T0 + 60_000);
    assert.equal(commitmentsContext(readCommitments(dir), T0 + 120_000), '', 'nothing open, nothing in the prompt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('overdue items and day-old items without a next step or progress are flagged and listed first', () => {
  const dir = temp();
  try {
    const fresh = addCommitment(dir, { text: 'fresh', source: '1', next: 'x' }, T0);
    const late = addCommitment(dir, { text: 'late', source: '2', next: 'y', dueInMinutes: 10 }, T0);
    const aimless = addCommitment(dir, { text: 'aimless', source: '3' }, T0);
    const now = T0 + STALE_MS + 60_000;
    const lines = commitmentsContext(readCommitments(dir), now).split('\n').slice(1);
    assert.match(lines[0]!, new RegExp(`^- ⚠ OVERDUE 23h51m · ${late.id}`));
    assert.ok(lines.some(l => l.includes(`⚠ no next step for 24h+ · ${aimless.id}`)));
    assert.ok(lines.some(l => l.includes(`⚠ no progress for 24h1m · ${fresh.id}`)), 'a next step alone does not keep an item fresh forever');
    updateCommitment(dir, { id: fresh.id, progress: 'CI started' }, now);
    assert.ok(!commitmentsContext(readCommitments(dir), now).includes(`⚠ no progress for 24h1m · ${fresh.id}`), 'progress resets the stale clock');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a new operator decision supersedes the old item, which is dropped, not left open', () => {
  const dir = temp();
  try {
    const old = addCommitment(dir, { text: 'deploy Friday', source: '10', owner: 'operator' }, T0);
    assert.equal(old.status, 'waiting_operator');
    const replacement = addCommitment(dir, { text: 'deploy Monday', source: '11', owner: 'operator', supersedes: old.id }, T0 + 1);
    const items = readCommitments(dir);
    assert.equal(items.find(c => c.id === old.id)!.status, 'dropped');
    assert.match(items.find(c => c.id === old.id)!.notes.at(-1)!.text, new RegExp(`superseded by ${replacement.id}`));
    assert.throws(() => addCommitment(dir, { text: 'again', source: '12', supersedes: old.id }, T0 + 2), /already dropped/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the 07:00 summary lists what waits on the operator and my overdue or stuck items', () => {
  const dir = temp();
  try {
    addCommitment(dir, { text: 'Approve the DentAI deploy', source: '1', owner: 'operator' }, T0);
    addCommitment(dir, { text: 'Fix flaky test', source: '2', next: 'rerun', dueInMinutes: 60 }, T0);
    addCommitment(dir, { text: 'On track', source: '3', next: 'z', dueInMinutes: 600 }, T0);
    const lines = summaryLines(readCommitments(dir), T0 + 2 * 3_600_000);
    assert.deepEqual(lines.waiting, ['Approve the DentAI deploy']);
    assert.deepEqual(lines.attention, ['Fix flaky test — atrasado 1h']);
    const text = composeSummary({ day: [], waiting: [], prs: [], approvals: 0, commitments: lines });
    assert.match(text, /\*Esperando você\*\n• Pendência: Approve the DentAI deploy/);
    assert.match(text, /\*Compromissos meus atrasados ou parados \(1\)\*\n• Fix flaky test — atrasado 1h/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('presence: 10 min without a word to the operator, then 30 min without recorded progress, each nudged once until reset', () => {
  const p = new Presence();
  assert.equal(p.check(T0), undefined, 'no turn running');
  p.start(T0);
  assert.equal(p.check(T0 + PRESENCE_REPORT_MS - 1), undefined);
  assert.match(p.check(T0 + PRESENCE_REPORT_MS)!, /10m without a word to the operator.*slack_send/);
  assert.equal(p.check(T0 + PRESENCE_REPORT_MS + 1), undefined, 'once');
  p.reported(T0 + 22 * 60_000);
  assert.equal(p.check(T0 + 25 * 60_000), undefined, 'a Slack line resets the report clock');
  const stall = p.check(T0 + PRESENCE_STALL_MS);
  assert.match(stall!, /30m without recorded progress.*Stop and change course/, 'a Slack line is not progress');
  assert.equal(p.check(T0 + PRESENCE_STALL_MS + 1), undefined);
  p.progressed(T0 + 31 * 60_000); p.reported(T0 + 31 * 60_000);
  assert.equal(p.check(T0 + 40 * 60_000), undefined, 'progress resets the stall clock');
  assert.match(p.check(T0 + 61 * 60_000)!, /30m without recorded progress/, 'and the stall nudge comes back after another 30 min');
  p.start(T0 + 50 * 60_000);
  assert.equal(p.check(T0 + 55 * 60_000), undefined, 'a new turn starts both clocks');
});

test('presence counts the operator as told only when slack_send succeeds, through the registered hooks', () => {
  const dir = temp();
  type Handler = (event: Record<string, unknown>) => unknown;
  const handlers = new Map<string, Handler>();
  const pi = { registerTool: () => {}, on: (name: string, handler: Handler) => { handlers.set(name, handler); } };
  let now = T0;
  registerCommitments(pi as never, () => ({ dir, sourceExists: () => true }), () => now);
  const fire = (name: string, event: Record<string, unknown>) => handlers.get(name)?.(event);
  const send = (isError: boolean) => {
    fire('tool_call', { toolName: 'slack_send', toolCallId: 's', input: {} });
    return fire('tool_result', { toolName: 'slack_send', toolCallId: 's', input: {}, isError, content: [{ type: 'text', text: isError ? 'refused' : 'Sent' }] });
  };
  const otherTool = () => plainToolResult(fire);
  try {
    fire('agent_start', {});
    now = T0 + PRESENCE_REPORT_MS + 60_000;
    const failed = send(true) as { content: { text: string }[] } | undefined;
    assert.match(failed?.content.at(-1)?.text ?? '', /without a word to the operator/, 'a refused or failed send told the operator nothing');
    fire('agent_start', {});
    now += PRESENCE_REPORT_MS + 60_000;
    send(false);
    assert.equal(otherTool(), undefined, 'a delivered send resets the report clock');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the tool requires a real source message and reports progress', async () => {
  const dir = temp();
  let progressed = 0;
  const tool = commitmentsTool(() => ({ dir, sourceExists: id => id === '5' }), () => { progressed++; });
  try {
    await assert.rejects(tool.execute('a', { action: 'add', text: 'x', source: '6' }), /source/);
    const added = await tool.execute('b', { action: 'add', text: 'Answer question 90587', source: '5', next: 'reply' });
    const id = /c_[0-9a-f]{6}/.exec(added.content[0]!.text)![0];
    await tool.execute('c', { action: 'update', id, progress: 'drafted' });
    assert.equal(progressed, 2);
    const listed = await tool.execute('d', { action: 'list' });
    assert.match(listed.content[0]!.text, /Answer question 90587 — next: reply · last: \d\d:\d\d drafted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
