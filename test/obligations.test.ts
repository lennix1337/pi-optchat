import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HEARTBEAT, Heartbeat, beatSnapshot, signalWakeText, wakeText, type Beat } from '../src/heartbeat.ts';
import { commitmentsTool, readCommitments } from '../src/commitments.ts';
import {
  DEFAULT_UNANSWERED_MINUTES,
  formatObligations,
  liveObligations,
  nextObligationAt,
  urgentObligations,
  type ObligationCommitment,
  type UnansweredMessage,
} from '../src/obligations.ts';
import { defaults, loadConfig, saveConfig } from '../src/profiles.ts';
import { SlackBridge } from '../src/slack-bridge.ts';
import { recordAnswer, recordInbound, readUnansweredMessages } from '../src/slack-metrics.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();

const commitment = (extra: Partial<ObligationCommitment> = {}): ObligationCommitment => ({
  id: 'c_100001',
  text: 'ship release notes',
  owner: 'optchat',
  status: 'open',
  createdAt: iso(T0 - 2 * HOUR),
  progressAt: iso(T0 - 2 * HOUR),
  ...extra,
});

test('liveObligations merges open commitments, overdue commitments and unanswered operator messages into one ranked list', () => {
  const commitments: ObligationCommitment[] = [
    commitment({ id: 'c_done', status: 'done', due: iso(T0 - HOUR) }),
    commitment({ id: 'c_dropped', status: 'dropped', due: iso(T0 - HOUR) }),
    commitment({ id: 'c_wait_op', owner: 'operator', status: 'waiting_operator', createdAt: iso(T0 - 5 * HOUR) }),
    commitment({ id: 'c_wait_choices', status: 'waiting_operator', choices: ['go', 'hold'], due: iso(T0 - 30 * HOUR) }),
    commitment({ id: 'c_open_plain', text: 'document api', createdAt: iso(T0 - 3 * HOUR) }),
    commitment({ id: 'c_due_soon', text: 'review patch', due: iso(T0 + 20 * MIN) }),
    commitment({ id: 'c_due_later', text: 'update changelog', due: iso(T0 + 2 * HOUR) }),
    commitment({ id: 'c_stale', text: 'investigate flake', createdAt: iso(T0 - 30 * HOUR), progressAt: iso(T0 - 26 * HOUR) }),
    commitment({ id: 'c_overdue_recent', text: 'verify staging', due: iso(T0 - 10 * MIN), project: 'ops' }),
    commitment({ id: 'c_overdue_old', text: 'fix build', due: iso(T0 - 3 * HOUR), project: 'app' }),
    commitment({ id: 'c_wait_stuck', status: 'waiting_operator', due: iso(T0 - 25 * HOUR), text: 'stuck without choices' }),
  ];
  const messages: UnansweredMessage[] = [
    { channel: 'fresh', at: T0 - 14 * MIN },
    { channel: 'ops', at: T0 - 16 * MIN },
    { channel: null, at: T0 - 25 * MIN, nudge: true },
    { channel: null, at: T0 - 18 * MIN },
  ];

  const list = liveObligations({ commitments, messages, now: T0 });
  assert.deepEqual(
    list.map(o => [o.key, o.kind, o.urgent]),
    [
      [`msg:dm@${T0 - 25 * MIN}`, 'unanswered', true],
      [`msg:ops@${T0 - 16 * MIN}`, 'unanswered', true],
      [`commitment:c_wait_stuck@${iso(T0 - 25 * HOUR)}`, 'overdue', true],
      [`commitment:c_overdue_old@${iso(T0 - 3 * HOUR)}`, 'overdue', true],
      [`commitment:c_overdue_recent@${iso(T0 - 10 * MIN)}`, 'overdue', true],
      ['commitment:c_stale@open', 'open', false],
      [`commitment:c_due_soon@${iso(T0 + 20 * MIN)}`, 'open', false],
      [`commitment:c_due_later@${iso(T0 + 2 * HOUR)}`, 'open', false],
      ['commitment:c_open_plain@open', 'open', false],
      ['commitment:c_wait_op@waiting', 'open', false],
      ['commitment:c_wait_choices@waiting', 'open', false],
    ],
  );
  assert.match(list[0]!.summary, /DM/);
  assert.match(list[0]!.summary, /2 messages/);
  assert.match(list[0]!.summary, /nudged/);
  assert.equal(list[3]!.project, 'app');
});

test('unansweredMinutes threshold is configurable with default 15 and 0 disables unanswered message obligations', () => {
  assert.equal(DEFAULT_UNANSWERED_MINUTES, 15);
  const messages: UnansweredMessage[] = [{ channel: null, at: T0 - 10 * MIN }];
  assert.deepEqual(liveObligations({ messages, now: T0 }), []);
  assert.equal(liveObligations({ messages, now: T0, unansweredMinutes: 10 }).length, 1);
  assert.deepEqual(liveObligations({ messages, now: T0, unansweredMinutes: 0 }), []);
});

test('nextObligationAt returns the soonest strictly future deadline across commitments and unanswered messages', () => {
  const commitments = [
    commitment({ id: 'c_past', due: iso(T0 - MIN) }),
    commitment({ id: 'c_future', due: iso(T0 + 20 * MIN) }),
    commitment({ id: 'c_done', status: 'done', due: iso(T0 + 2 * MIN) }),
  ];
  const messages: UnansweredMessage[] = [{ channel: null, at: T0 - 5 * MIN }];
  assert.equal(nextObligationAt({ commitments, messages, now: T0 }), T0 + 10 * MIN);
  assert.equal(nextObligationAt({ commitments, messages: [], now: T0 }), T0 + 20 * MIN + 30_000);
  assert.equal(nextObligationAt({ commitments: [commitments[0]!], messages: [{ channel: null, at: T0 - 20 * MIN }], now: T0 }), undefined);
});

test('urgentObligations deduplicates by stable key and drops resolved keys', () => {
  const first = liveObligations({
    commitments: [commitment({ id: 'c_1', due: iso(T0 - MIN) })],
    messages: [{ channel: null, at: T0 - 20 * MIN }],
    now: T0,
  });
  const a = urgentObligations(first, []);
  assert.equal(a.fresh.length, 2);
  const b = urgentObligations(first, a.seen);
  assert.deepEqual(b.fresh, []);
  assert.deepEqual(b.seen, a.seen);

  const afterAnswer = liveObligations({
    commitments: [commitment({ id: 'c_1', due: iso(T0 - MIN) })],
    messages: [],
    now: T0 + MIN,
  });
  const c = urgentObligations(afterAnswer, b.seen);
  assert.deepEqual(c.fresh, []);
  assert.deepEqual(c.seen, [`commitment:c_1@${iso(T0 - MIN)}`]);
});

test('readUnansweredMessages pairs inbound and outbound entries per channel from slack-metrics.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oblig-slack-'));
  try {
    assert.deepEqual(readUnansweredMessages(dir), []);
    recordInbound(dir, null, 'hello?', T0);
    recordInbound(dir, null, 'e aí?', T0 + 2 * MIN);
    recordInbound(dir, 'ops', 'deploy status', T0 + 3 * MIN);
    assert.deepEqual(readUnansweredMessages(dir), [
      { channel: null, at: T0, count: 2, nudge: true },
      { channel: 'ops', at: T0 + 3 * MIN, count: 1 },
    ]);
    recordAnswer(dir, null, T0 + 4 * MIN);
    assert.deepEqual(readUnansweredMessages(dir), [
      { channel: 'ops', at: T0 + 3 * MIN, count: 1 },
    ]);
    recordAnswer(dir, 'ops', T0 + 5 * MIN);
    assert.deepEqual(readUnansweredMessages(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unansweredMinutes config defaults to 15, round-trips and rejects invalid values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oblig-cfg-'));
  try {
    assert.equal(defaults.unansweredMinutes, 15);
    saveConfig(dir, defaults);
    assert.equal(loadConfig(dir).unansweredMinutes, 15);
    saveConfig(dir, { ...defaults, unansweredMinutes: 25 });
    assert.equal(loadConfig(dir).unansweredMinutes, 25);
    saveConfig(dir, { ...defaults, unansweredMinutes: 0 });
    assert.equal(loadConfig(dir).unansweredMinutes, 0);
    saveConfig(dir, { ...defaults, unansweredMinutes: -1 as never });
    assert.throws(() => loadConfig(dir), /Invalid profile config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat prompts include top ranked obligations when present and stay unchanged when empty', () => {
  const list = liveObligations({
    commitments: [
      commitment({ id: 'c_1', text: 'finish migration', due: iso(T0 - 2 * HOUR) }),
      commitment({ id: 'c_2', text: 'check staging', due: iso(T0 + HOUR) }),
    ],
    messages: [{ channel: null, at: T0 - 20 * MIN }],
    now: T0,
  });
  const block = formatObligations(list, 2);
  assert.match(block, /Live obligations \(top 2 of 3/);
  assert.match(block, /operator message unanswered 20m in DM/);
  assert.match(block, /finish migration/);
  assert.doesNotMatch(block, /check staging/);
  assert.equal(formatObligations([]), '');

  const snapshot = beatSnapshot({ view: 'v', state: '', idleMinutes: 30, agents: [], shells: [], obligations: list });
  assert.match(snapshot, /Live obligations/);
  assert.match(snapshot, /finish migration/);
  assert.doesNotMatch(beatSnapshot({ view: 'v', state: '', idleMinutes: 30, agents: [], shells: [] }), /Live obligations/);

  const wake = wakeText('continue work', 'fixture-model', 30, DEFAULT_HEARTBEAT, undefined, undefined, {}, list);
  assert.match(wake, /Live obligations/);
  assert.match(wake, /operator message unanswered 20m in DM/);
  assert.equal(
    wakeText('continue work', 'fixture-model', 30, DEFAULT_HEARTBEAT, undefined, undefined, {}, []),
    wakeText('continue work', 'fixture-model', 30, DEFAULT_HEARTBEAT),
  );

  const signal = signalWakeText(10, DEFAULT_HEARTBEAT, 'signal note', {}, list);
  assert.match(signal, /Live obligations/);
  assert.match(signal, /finish migration/);
});

function obligationHarness({
  minutes = 30,
  wakes = 10,
  unansweredMinutes = 15,
  commitments = [] as ObligationCommitment[],
  messages = [] as UnansweredMessage[],
  busy = () => undefined as string | undefined,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oblig-beat-'));
  let now = T0;
  let timer: { at: number; run: () => void } | undefined;
  let timerCount = 0;
  const woken: Beat[] = [];
  const checks: number[] = [];
  const notes: string[] = [];
  const beat = new Heartbeat({
    dir,
    now: () => now,
    minutes: () => minutes,
    maxWakes: () => wakes,
    always: () => false,
    busy,
    obligations: () => ({ commitments, messages, unansweredMinutes }),
    check: async () => { checks.push(now); return { wake: false, text: 'quiet' }; },
    wake: b => { woken.push(b); },
    note: text => { notes.push(text); },
    setTimer: (run, ms) => { timerCount++; timer = { at: now + ms, run }; return timer; },
    clearTimer: handle => { if (timer === handle) timer = undefined; },
  });
  const advance = async (ms: number) => {
    const until = now + ms;
    while (timer && timer.at <= until) {
      const t = timer;
      timer = undefined;
      now = t.at;
      t.run();
      await beat.settled();
    }
    now = until;
  };
  return {
    dir, beat, woken, checks, notes, commitments, messages,
    now: () => now,
    setNow: (at: number) => { now = at; },
    pending: () => timer ? timer.at - now : undefined,
    timerCount: () => timerCount,
    advance,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('new overdue obligation appearing between heartbeats requests a wake once and never repeats for the same obligation', async () => {
  const h = obligationHarness({ minutes: 30 });
  try {
    h.beat.arm();
    assert.equal(h.pending(), 30 * MIN);

    h.setNow(T0 + 5 * MIN);
    h.commitments.push(commitment({ id: 'c_urgent', text: 'deploy hotfix', due: iso(T0 + 4 * MIN), project: 'app' }));
    assert.equal(h.beat.notifyObligations(), true);
    await h.beat.settled();

    assert.equal(h.woken.length, 1, 'woke immediately at 5 min instead of waiting for 30 min');
    assert.equal(h.woken[0]!.trigger, 'signal');
    assert.equal(h.checks.length, 0, 'did not need a cheap model check for an urgent obligation');
    assert.ok(h.woken[0]!.obligations?.some(o => o.commitmentId === 'c_urgent'));

    h.beat.turnSettled({ reply: 'checked hotfix', tools: 1, commits: [] });
    h.beat.arm();

    assert.equal(h.beat.notifyObligations(), false, 'same overdue obligation never wakes again');
    await h.beat.settled();
    assert.equal(h.woken.length, 1);

    await h.advance(30 * MIN);
    assert.equal(h.woken.length, 1, 'subsequent heartbeat tick does not repeat the same overdue obligation');

    const saved = JSON.parse(readFileSync(join(h.dir, 'heartbeat.json'), 'utf8'));
    assert.deepEqual(saved.obligationSeen, [`commitment:c_urgent@${iso(T0 + 4 * MIN)}`]);

    h.commitments.push(commitment({ id: 'c_second', text: 'check alert', due: iso(h.now() - MIN) }));
    assert.equal(h.beat.notifyObligations(), true, 'a different overdue obligation wakes once');
    await h.beat.settled();
    assert.equal(h.woken.length, 2);
  } finally {
    h.close();
  }
});

test('a commitment becoming overdue or an operator message crossing unansweredMinutes between heartbeats shortens the existing timer and wakes once', async () => {
  const h = obligationHarness({ minutes: 30, unansweredMinutes: 15 });
  try {
    h.beat.arm();
    assert.equal(h.pending(), 30 * MIN);

    h.setNow(T0 + 2 * MIN);
    h.messages.push({ channel: null, at: T0 + 2 * MIN });
    assert.equal(h.beat.notifyObligations(), false, 'not yet 15 min old');
    assert.equal(h.pending(), 15 * MIN, 'reuses the existing single timer to wake right at 15 min');

    await h.advance(15 * MIN);
    assert.equal(h.woken.length, 1, 'woke right at 17 min (15 min after message), not 30 min');
    assert.equal(h.woken[0]!.trigger, 'signal');
    assert.match(h.woken[0]!.signals![0]!.lines[0]!, /operator message unanswered 15m in DM/);

    h.beat.turnSettled({ reply: 'replied to operator', tools: 1, commits: [] });
    h.beat.arm();
    await h.advance(30 * MIN);
    assert.equal(h.woken.length, 1, 'same unanswered message never triggers a second wake');
  } finally {
    h.close();
  }
});

test('an urgent obligation held back by the daily wake cap is not marked seen and stays pending', async () => {
  const h = obligationHarness({ minutes: 30, wakes: 0 });
  try {
    h.commitments.push(commitment({ id: 'c_cap', text: 'urgent fix', due: iso(T0 - MIN) }));
    assert.equal(h.beat.notifyObligations(), true);
    await h.beat.settled();
    assert.equal(h.woken.length, 0);
    assert.equal(h.notes.length, 1);
    const saved = JSON.parse(readFileSync(join(h.dir, 'heartbeat.json'), 'utf8'));
    assert.equal(saved.obligationSeen, undefined);
  } finally {
    h.close();
  }
});

test('commitmentsTool and SlackBridge callbacks forward to Heartbeat.notifyObligations without a polling loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oblig-chain-'));
  let now = T0;
  let timer: { at: number; run: () => void } | undefined;
  const woken: Beat[] = [];
  const beat = new Heartbeat({
    dir,
    now: () => now,
    minutes: () => 30,
    maxWakes: () => 10,
    always: () => false,
    busy: () => undefined,
    obligations: () => ({
      commitments: readCommitments(dir),
      messages: readUnansweredMessages(dir),
      unansweredMinutes: 15,
    }),
    check: async () => ({ wake: false, text: 'quiet' }),
    wake: b => { woken.push(b); },
    note: () => {},
    setTimer: (run, ms) => { timer = { at: now + ms, run }; return timer; },
    clearTimer: handle => { if (timer === handle) timer = undefined; },
  });
  const tool = commitmentsTool(() => ({ dir, sourceExists: () => true }), () => {}, () => { beat.notifyObligations(); });
  const inbox = [{ seq: 1, ts: '1.0', thread: null, text: 'any update?' }];
  const bridge = new SlackBridge(
    { sendUserMessage: (() => {}) as never },
    () => ({ dir, name: 'fixture' }),
    {
      now: () => now,
      request: async (_owner, path) => path.startsWith('/v1/slack/inbox') ? { messages: inbox } : { parts: 1, ts: '1.1' },
      onInbound: () => { beat.notifyObligations(); },
    },
  );
  try {
    beat.arm();
    assert.equal(timer!.at, T0 + 30 * MIN);

    await tool.execute('t1', { action: 'add', text: 'overdue task', source: '1', due: iso(T0 - MIN) });
    await beat.settled();
    assert.equal(woken.length, 1, 'adding an overdue commitment through commitmentsTool wakes right away');
    beat.turnSettled({ reply: 'handled', tools: 1, commits: [] });
    beat.arm();

    now = T0 + 2 * MIN;
    await bridge.poll();
    assert.equal(timer!.at, now + 15 * MIN, 'inbound Slack message shortens the existing heartbeat timer to unansweredMinutes');

    const t = timer!;
    timer = undefined;
    now = t.at;
    t.run();
    await beat.settled();
    assert.equal(woken.length, 2, 'single timer wakes once the operator message crosses 15 min');
    assert.match(woken[1]!.signals![0]!.lines[0]!, /operator message unanswered 15m in DM/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with wakeTriage an unanswered operator message wakes once without repeating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oblig-triage-'));
  let now = T0;
  let timer: { at: number; run: () => void } | undefined;
  const woken: Beat[] = [];
  const messages: UnansweredMessage[] = [{ channel: 'ops', at: T0 }];
  const beat = new Heartbeat({
    dir,
    now: () => now,
    minutes: () => 30,
    maxWakes: () => 10,
    always: () => true,
    busy: () => undefined,
    triage: () => ({ buildMinutes: 120, missions: '', lastRuns: {}, commitments: [] }),
    obligations: () => ({ commitments: [], messages, unansweredMinutes: 15 }),
    check: async () => ({ wake: false, text: 'quiet' }),
    wake: b => { woken.push(b); },
    note: () => {},
    setTimer: (run, ms) => { timer = { at: now + ms, run }; return timer; },
    clearTimer: handle => { if (timer === handle) timer = undefined; },
  });
  const advance = async (ms: number) => {
    const until = now + ms;
    while (timer && timer.at <= until) {
      const t = timer;
      timer = undefined;
      now = t.at;
      t.run();
      await beat.settled();
    }
    now = until;
  };
  try {
    beat.arm();
    assert.equal(timer!.at, T0 + 15 * MIN);
    await advance(15 * MIN);
    assert.equal(woken.length, 1);
    assert.equal(woken[0]!.trigger, 'signal');
    assert.equal(woken[0]!.signals![0]!.project, 'ops');
    beat.turnSettled({ reply: 'answered', tools: 1, commits: [] });
    beat.arm();
    await advance(30 * MIN);
    assert.equal(woken.length, 1, 'same unanswered message never repeats in triage mode');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
