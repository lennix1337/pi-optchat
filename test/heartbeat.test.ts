import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HEARTBEAT, HEARTBEAT_PROMPT, Heartbeat, beatSnapshot, checkBeat, heartbeatPlan, wakeText, type Beat } from '../src/heartbeat.ts';
import { defaults, loadConfig, saveConfig } from '../src/profiles.ts';

const MIN = 60_000;

/** A clock and one timer slot the test advances by hand. */
function harness({ minutes = 30, wakes = 2, verdicts = [] as (Beat | Error)[], busy = () => undefined as string | undefined, dir = mkdtempSync(join(tmpdir(), 'beat-')) } = {}) {
  let now = 0, timer: { at: number; run: () => void } | undefined;
  const checks: number[] = [], woken: string[] = [], notes: string[] = [];
  const beat = new Heartbeat({
    dir, now: () => now, minutes: () => minutes, maxWakes: () => wakes, busy,
    setTimer: (run, ms) => { timer = { at: now + ms, run }; return timer; },
    clearTimer: handle => { if (timer === handle) timer = undefined; },
    check: async () => { checks.push(now); const v = verdicts.shift() ?? { wake: false, text: 'nothing to do' }; if (v instanceof Error) throw v; return v; },
    wake: beat => { woken.push(beat.text); },
    note: text => { notes.push(text); },
  });
  const advance = async (ms: number) => {
    const until = now + ms;
    while (timer && timer.at <= until) { const t = timer; timer = undefined; now = t.at; t.run(); await beat.settled(); }
    now = until;
  };
  return { beat, checks, woken, notes, advance, dir, pending: () => timer && timer.at - now, setMinutes: (m: number) => { minutes = m; } };
}

test('an idle chat gets one cheap check after the interval, and a SLEEP keeps the same interval', async () => {
  const h = harness();
  h.beat.arm();
  await h.advance(29 * MIN); assert.deepEqual(h.checks, []);
  await h.advance(1 * MIN); assert.deepEqual(h.checks, [30 * MIN]);
  assert.equal(h.pending(), 30 * MIN, 'a quiet check does not stretch the wait');
  await h.advance(30 * MIN); assert.equal(h.checks.length, 2);
  assert.equal(h.pending(), 30 * MIN);
  assert.deepEqual(h.woken, []);
  rmSync(h.dir, { recursive: true, force: true });
});

test('a long idle stretch is checked every interval, never less often', async () => {
  const h = harness();
  h.beat.arm();
  await h.advance(8 * 30 * MIN);
  assert.deepEqual(h.checks, [1, 2, 3, 4, 5, 6, 7, 8].map(n => n * 30 * MIN));
  assert.equal(h.pending(), 30 * MIN);
  rmSync(h.dir, { recursive: true, force: true });
});

test('a WAKE verdict wakes the main agent with the task, and no timer runs while it works', async () => {
  const h = harness({ verdicts: [{ wake: true, text: 'finish the DENTA-90 PR' }] });
  h.beat.arm();
  await h.advance(30 * MIN);
  assert.equal(h.woken.length, 1);
  assert.match(h.woken[0], /finish the DENTA-90 PR/);
  assert.equal(h.pending(), undefined, 'the woken turn re-arms it when it settles');
  h.beat.arm();
  assert.equal(h.pending(), 30 * MIN, 'the woken turn re-arms the same interval');
  rmSync(h.dir, { recursive: true, force: true });
});

test('wakes per day are capped; past the cap a WAKE is noted and checks go on at the interval', async () => {
  const wake = { wake: true, text: 'do it' };
  const h = harness({ wakes: 1, verdicts: [wake, wake] });
  h.beat.arm(); await h.advance(30 * MIN);
  h.beat.arm(); await h.advance(30 * MIN);
  assert.equal(h.woken.length, 1);
  assert.match(h.notes.join('\n'), /1 wake.*24 h/);
  assert.equal(h.pending(), 30 * MIN);
  rmSync(h.dir, { recursive: true, force: true });
});

test('the daily count survives a reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beat-'));
  const first = harness({ dir, wakes: 1, verdicts: [{ wake: true, text: 'a' }] });
  first.beat.arm(); await first.advance(30 * MIN);
  const second = harness({ dir, wakes: 1, verdicts: [{ wake: true, text: 'b' }] });
  second.beat.arm(); await second.advance(30 * MIN);
  assert.deepEqual(second.woken, []);
  rmSync(dir, { recursive: true, force: true });
});

test('a busy chat skips the model call and tries again an interval later', async () => {
  let reason: string | undefined = 'main agent working';
  const h = harness({ busy: () => reason });
  h.beat.arm(); await h.advance(30 * MIN);
  assert.deepEqual(h.checks, []);
  assert.equal(h.pending(), 30 * MIN);
  reason = undefined; await h.advance(30 * MIN);
  assert.equal(h.checks.length, 1);
  rmSync(h.dir, { recursive: true, force: true });
});

test('operator input disarms it; 0 minutes turns it off', async () => {
  const h = harness();
  h.beat.arm(); await h.advance(30 * MIN);
  assert.equal(h.pending(), 30 * MIN);
  h.beat.operatorSpoke();
  assert.equal(h.pending(), undefined);
  h.beat.arm(); assert.equal(h.pending(), 30 * MIN);
  h.beat.disarm(); h.setMinutes(0); h.beat.arm();
  assert.equal(h.pending(), undefined);
  rmSync(h.dir, { recursive: true, force: true });
});

test('a failed check is noted once and retried at the interval like a SLEEP', async () => {
  const h = harness({ verdicts: [new Error('rate limited'), new Error('rate limited')] });
  h.beat.arm(); await h.advance(30 * MIN); await h.advance(30 * MIN);
  assert.equal(h.checks.length, 2);
  assert.equal(h.notes.filter(n => /rate limited/.test(n)).length, 1);
  assert.deepEqual(h.woken, []);
  rmSync(h.dir, { recursive: true, force: true });
});

const model = { provider: 'anthropic', id: 'claude-haiku-5-5', api: 'anthropic-messages', reasoning: false, contextWindow: 200_000, maxTokens: 64_000 };
function registry(text: string) {
  const sent: any[] = [];
  return { sent, find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
    streamSimple: (_m: unknown, context: unknown, options: unknown) => { sent.push({ context, options }); return { result: async () => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: {}, timestamp: 0 }) }; } } as any;
}
const choice = { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'high' as const };

test('the check reads one WAKE/SLEEP line from the cheap model, thinking off', async () => {
  const wake = registry('WAKE: the last turn stopped on a quota error mid-task');
  assert.deepEqual(await checkBeat(wake, choice, 'snapshot', () => {}), { wake: true, text: 'the last turn stopped on a quota error mid-task', model: 'anthropic/claude-haiku-5-5' });
  assert.equal(wake.sent[0].context.systemPrompt, HEARTBEAT_PROMPT);
  assert.equal(wake.sent[0].options.reasoning, undefined);
  assert.equal((await checkBeat(registry('sleep - waiting on the operator'), choice, 's', () => {})).wake, false);
  await assert.rejects(checkBeat(registry('maybe'), choice, 's', () => {}), /verdict/);
});

test('the snapshot carries the stall evidence and only the tail of a long view', () => {
  const text = beatSnapshot({ view: `${'old line\n'.repeat(10_000)}newest line`, state: 'objective: x', idleMinutes: 42,
    lastStop: 'error: 429 quota exhausted', agents: ['a1 working 3h: build'], shells: [] });
  assert.match(text, /newest line/);
  assert.ok(text.length < 40_000);
  assert.match(text, /42 min/); assert.match(text, /429 quota/); assert.match(text, /a1 working 3h/); assert.match(text, /objective: x/);
});

test('the default wake plan bounds what an unattended turn may do', () => {
  const text = wakeText('fix the flaky test', 'anthropic/claude-haiku-5-5', 45, DEFAULT_HEARTBEAT);
  assert.match(text, /^\[OptChat heartbeat\]/);
  assert.match(text, /fix the flaky test/);
  assert.match(text, /pull request/i);
  assert.match(text, /Never[^]*Merge/);
  assert.match(text, /deploy/);
});

const plan = { jobs: ['DentAI: leave a Plane issue PR ready'], allowed: ['improve the harness, measured'], never: ['message customers'] };

test('the wake hands the configured plan to the main agent, which does the work itself', () => {
  const text = wakeText('continue task-7', 'anthropic/claude-haiku-5-5', 45, plan);
  assert.match(text, /continue task-7/);
  assert.match(text, /DentAI: leave a Plane issue PR ready/);
  assert.match(text, /improve the harness, measured/);
  assert.match(text, /message customers/);
  assert.match(text, /you do the work/i);
  assert.doesNotMatch(text, /deploy/);
});

test('a question the operator already answered does not count as waiting on them, for the check or the woken turn', () => {
  assert.match(HEARTBEAT_PROMPT, /already answer[^]*does not wait on the operator/);
  assert.match(wakeText('x', 'm', 30, plan), /does not wait on them when their earlier words already answer it/);
});

test('the check reads the configured jobs and limits, so it only wakes for allowed work', () => {
  const text = beatSnapshot({ view: 'v', state: '', idleMinutes: 30, agents: [], shells: [], plan });
  assert.match(text, /DentAI: leave a Plane issue PR ready/);
  assert.match(text, /improve the harness, measured/);
  assert.match(text, /message customers/);
});

test('a profile keeps its heartbeat plan in config.json; without one it uses the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-heartbeat-config-'));
  saveConfig(dir, { ...defaults, heartbeat: plan });
  assert.deepEqual(loadConfig(dir).heartbeat, plan);
  saveConfig(dir, defaults);
  assert.deepEqual(heartbeatPlan(loadConfig(dir)), DEFAULT_HEARTBEAT);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaults, heartbeat: { jobs: 'x', allowed: [], never: [] } }));
  assert.throws(() => loadConfig(dir), /heartbeat/);
  rmSync(dir, { recursive: true, force: true });
});
