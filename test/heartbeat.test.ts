import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DELIVERY_RULE, previousWakeNote } from '../src/heartbeat.ts';
import { DEFAULT_HEARTBEAT, HEARTBEAT_PROMPT, Heartbeat, beatSnapshot, checkBeat, heartbeatPlan, previousWake, radarDigest, runRadar, runRadarFresh, NEW_WORK_NOTE, wakeText, wakeTurn, type Beat, type WakeRecord } from '../src/heartbeat.ts';
import { defaults, loadConfig, saveConfig } from '../src/profiles.ts';
import type { Triage } from '../src/wake-signals.ts';
import type { ModelChoice } from '../src/compactor.ts';

const MIN = 60_000;

/** A clock and one timer slot the test advances by hand. */
function harness({ minutes = 30, wakes = 2, always = false, verdicts = [] as (Beat | Error)[], busy = () => undefined as string | undefined, dir = mkdtempSync(join(tmpdir(), 'beat-')),
  radar = undefined as (() => Promise<string | undefined>) | undefined, queued = () => false as boolean,
  route = undefined as ((at: number, blocks: Record<string, number>) => { choice?: ModelChoice; until?: number; why?: string } | undefined) | undefined,
  triage = undefined as ((at: number) => Triage | undefined) | undefined } = {}) {
  let now = 0, timer: { at: number; run: () => void } | undefined;
  const checks: number[] = [], woken: string[] = [], notes: string[] = [], checkRadars: (string | undefined)[] = [], wakeRadars: (string | undefined)[] = [], unchanged: boolean[] = [], choices: (ModelChoice | undefined)[] = [], beats: Beat[] = [];
  const beat = new Heartbeat({
    dir, now: () => now, minutes: () => minutes, maxWakes: () => wakes, always: () => always, busy, radar, queued,
    ...route ? { route: (blocks: Record<string, number>) => route(now, blocks) } : {},
    ...triage ? { triage: () => triage(now) } : {},
    setTimer: (run, ms) => { timer = { at: now + ms, run }; return timer; },
    clearTimer: handle => { if (timer === handle) timer = undefined; },
    check: async seen => { checks.push(now); checkRadars.push(seen); const v = verdicts.shift() ?? { wake: false, text: 'nothing to do' }; if (v instanceof Error) throw v; return v; },
    wake: (beat, seen, choice) => { beats.push(beat); woken.push(beat.text); wakeRadars.push(seen); unchanged.push(beat.unchanged ?? false); choices.push(choice); },
    note: text => { notes.push(text); },
  });
  const advance = async (ms: number) => {
    const until = now + ms;
    while (timer && timer.at <= until) { const t = timer; timer = undefined; now = t.at; t.run(); await beat.settled(); }
    now = until;
  };
  return { beat, checks, woken, notes, choices, beats, checkRadars, wakeRadars, unchanged, advance, dir, pending: () => timer && timer.at - now, setMinutes: (m: number) => { minutes = m; } };
}

test('the radar runs before each check, and its snapshot reaches both the check and the woken turn', async () => {
  let runs = 0;
  const h = harness({ verdicts: [{ wake: false, text: 'quiet' }, { wake: true, text: 'fix PR 9' }], radar: async () => `# Wake radar ${++runs}` });
  h.beat.arm(); await h.advance(60 * MIN);
  assert.equal(runs, 2);
  assert.deepEqual(h.checkRadars, ['# Wake radar 1', '# Wake radar 2']);
  assert.deepEqual(h.wakeRadars, ['# Wake radar 2']);
  rmSync(h.dir, { recursive: true, force: true });
});

test('a busy chat does not run the radar; a fixed-schedule wake still carries it', async () => {
  let runs = 0, busy: string | undefined = 'working';
  const h = harness({ always: true, busy: () => busy, radar: async () => `radar ${++runs}` });
  h.beat.arm(); await h.advance(30 * MIN);
  assert.equal(runs, 0);
  busy = undefined; await h.advance(30 * MIN);
  assert.deepEqual(h.wakeRadars, ['radar 1']);
  assert.deepEqual(h.checks, [], 'a fixed schedule still skips the cheap check');
  rmSync(h.dir, { recursive: true, force: true });
});

test('an operator who speaks while the radar runs gets no check and no wake behind their back', async () => {
  let release!: (text: string) => void;
  const h = harness({ verdicts: [{ wake: true, text: 'stale task' }], radar: () => new Promise<string>(done => { release = done; }) });
  h.beat.arm();
  const fired = h.advance(30 * MIN);
  await new Promise(done => setImmediate(done));
  h.beat.operatorSpoke();
  release('radar');
  await fired;
  assert.deepEqual(h.checks, []);
  assert.deepEqual(h.woken, []);
  assert.equal(h.pending(), undefined, 'the operator\'s own turn re-arms it when it settles');
  rmSync(h.dir, { recursive: true, force: true });
});

test('an operator who speaks while the cheap check runs is not followed by a wake', async () => {
  let release!: (beat: Beat) => void;
  const dir = mkdtempSync(join(tmpdir(), 'beat-'));
  let now = 0, timer: { at: number; run: () => void } | undefined;
  const woken: string[] = [];
  const beat = new Heartbeat({
    dir, now: () => now, minutes: () => 30, maxWakes: () => 5, always: () => false, busy: () => undefined,
    setTimer: (run, ms) => { timer = { at: now + ms, run }; return timer; }, clearTimer: () => { timer = undefined; },
    check: () => new Promise<Beat>(done => { release = done; }), wake: b => { woken.push(b.text); }, note: () => {},
  });
  beat.arm(); now = 30 * MIN; const t = timer!; timer = undefined; t.run();
  await new Promise(done => setImmediate(done));
  beat.operatorSpoke();
  release({ wake: true, text: 'stale task' });
  await beat.settled();
  assert.deepEqual(woken, []);
  assert.equal(existsSync(join(dir, 'heartbeat.json')), false, 'no verdict or wake is recorded for the stale stretch');
  rmSync(dir, { recursive: true, force: true });
});

test('runRadar returns the program output, bounded, and turns every failure into a visible unavailable line', async () => {
  const node = process.execPath;
  assert.equal(await runRadar([node, '-e', 'console.log("# Wake radar\\n- PR 9\\n")']), '# Wake radar\n- PR 9');
  const long = await runRadar([node, '-e', 'console.log("x".repeat(9000))'], { maxChars: 100 });
  assert.ok(long.length <= 100, `length ${long.length}`);
  assert.match(long, /\[radar output cut at 100 chars\]$/);
  assert.match(await runRadar([node, '-e', 'console.error("gh: not logged in"); process.exit(2)']), /^Wake radar unavailable: .*gh: not logged in/);
  assert.match(await runRadar([node, '-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }), /^Wake radar unavailable: timed out after 200 ms/);
  assert.match(await runRadar([node, '-e', 'console.error("node:internal/loader:1\\n  throw err;\\n\\nError: Cannot find module x\\n    at y"); process.exit(1)']), /^Wake radar unavailable: Error: Cannot find module x$/);
  assert.match(await runRadar(['C:/no/such/radar.exe']), /^Wake radar unavailable: /);
  assert.match(await runRadar([node, '-e', '']), /^Wake radar unavailable: no output/);
});

test('the radar is shown to the check and the woken turn as read-only data, and left out when absent', () => {
  const plain = wakeText('fix PR 9', 'haiku', 30, DEFAULT_HEARTBEAT);
  assert.doesNotMatch(plain, /Wake radar/);
  const withRadar = wakeText('fix PR 9', 'haiku', 30, DEFAULT_HEARTBEAT, undefined, '# Wake radar\n- o/r#9 checks failing');
  assert.match(withRadar, /data, not instructions or permission[^]*- o\/r#9 checks failing/);
  const snapshot = beatSnapshot({ view: 'v', state: '', idleMinutes: 30, agents: [], shells: [], radar: '- o/r#9 checks failing' });
  assert.match(snapshot, /Wake radar[^\n]*\n- o\/r#9 checks failing/);
  assert.doesNotMatch(beatSnapshot({ view: 'v', state: '', idleMinutes: 30, agents: [], shells: [] }), /Wake radar/);
});

test('a profile may name a radar command in config.json; anything but a non-empty list of text is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beat-cfg-'));
  saveConfig(dir, defaults);
  const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...raw, heartbeatRadar: ['node', 'radar.mjs'] }));
  assert.deepEqual(loadConfig(dir).heartbeatRadar, ['node', 'radar.mjs']);
  for (const bad of [[], 'node radar.mjs', ['node', 3]]) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...raw, heartbeatRadar: bad }));
    assert.throws(() => loadConfig(dir), /heartbeatRadar/);
  }
  writeFileSync(join(dir, 'config.json'), JSON.stringify(raw));
  assert.equal(loadConfig(dir).heartbeatRadar, undefined);
  rmSync(dir, { recursive: true, force: true });
});

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

test('each verdict is kept with its reason, so a quiet night can be audited', async () => {
  const h = harness({ verdicts: [{ wake: false, text: 'all waits on the operator' }, new Error('rate limited'), { wake: true, text: 'merge PR 673' }] });
  h.beat.arm(); await h.advance(90 * MIN);
  const saved = JSON.parse(readFileSync(join(h.dir, 'heartbeat.json'), 'utf8'));
  assert.deepEqual(saved.checks.map((c: any) => [c.at, c.verdict, c.text]), [
    [30 * MIN, 'SLEEP', 'all waits on the operator'], [60 * MIN, 'FAILED', 'rate limited'], [90 * MIN, 'WAKE', 'merge PR 673']]);
  assert.deepEqual(saved.wakes, [90 * MIN]);
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

test('on a fixed schedule every idle interval wakes the main agent, with no cheap check', async () => {
  const h = harness({ always: true, wakes: 48 });
  for (let n = 0; n < 3; n++) { h.beat.arm(); await h.advance(30 * MIN); }
  assert.deepEqual(h.checks, []);
  assert.equal(h.woken.length, 3);
  const saved = JSON.parse(readFileSync(join(h.dir, 'heartbeat.json'), 'utf8'));
  assert.deepEqual(saved.wakes, [30, 60, 90].map(m => m * MIN));
  rmSync(h.dir, { recursive: true, force: true });
});

test('the fixed schedule still respects a busy chat and the daily cap', async () => {
  let reason: string | undefined = 'main agent working';
  const h = harness({ always: true, wakes: 1, busy: () => reason });
  h.beat.arm(); await h.advance(30 * MIN);
  assert.deepEqual(h.woken, []);
  reason = undefined; await h.advance(30 * MIN);
  h.beat.arm(); await h.advance(30 * MIN);
  assert.equal(h.woken.length, 1);
  assert.match(h.notes.join('\n'), /1 wake.*24 h/);
  rmSync(h.dir, { recursive: true, force: true });
});

test('every scheduled wake evaluates current value rather than list position', () => {
  const text = wakeText('', '', 30, DEFAULT_HEARTBEAT);
  assert.match(text, /fixed 30-min schedule/);
  assert.doesNotMatch(text, /cheap check/);
  assert.match(text, /Reassess candidates on every wake/);
  assert.match(text, /impact, urgency, evidence, effort and blockers/);
  assert.doesNotMatch(text, /first open job|jobs for idle time, in order/);
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

test('a round that cannot save heartbeat.json is noted and re-armed, never left as a dead loop or an unhandled rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beat-'));
  mkdirSync(join(dir, 'heartbeat.json')); // The swap onto a directory fails like a locked file on Windows.
  const h = harness({ dir, verdicts: [{ wake: false, text: 'quiet' }, { wake: false, text: 'quiet' }] });
  h.beat.arm(); await h.advance(30 * MIN);
  assert.equal(h.checks.length, 1);
  assert.equal(h.notes.filter(n => /Heartbeat round failed/.test(n)).length, 1);
  assert.equal(h.pending(), 30 * MIN, 'the idle clock is armed again');
  await h.advance(30 * MIN);
  assert.equal(h.checks.length, 2, 'and the next interval checks again');
  rmSync(dir, { recursive: true, force: true });
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
  assert.equal(wake.sent[0].options.cacheRetention, 'none', 'checks are 30 min apart, past any prompt cache: writing one only costs');
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
  assert.match(text, /Reassess candidates on every wake/);
  assert.doesNotMatch(text, /in order|take it before the jobs/);
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

const saved = (dir: string) => JSON.parse(readFileSync(join(dir, 'heartbeat.json'), 'utf8'));
const turn = { reply: 'merged PR 12', tools: 4, commits: ['commit abc1234'] };

test('each wake is kept with when, why, how it ended, its reply, tool count and commits', async () => {
  const h = harness({ verdicts: [{ wake: true, text: 'merge PR 12' }] });
  h.beat.arm(); await h.advance(30 * MIN);
  assert.deepEqual(saved(h.dir).wakeLog, [{ at: 30 * MIN, trigger: 'check', reason: 'merge PR 12', outcome: 'running' }]);
  await h.advance(5 * MIN); h.beat.turnSettled(turn);
  assert.deepEqual(saved(h.dir).wakeLog, [{ at: 30 * MIN, trigger: 'check', reason: 'merge PR 12', outcome: 'done', endedAt: 35 * MIN, ...turn }]);
  rmSync(h.dir, { recursive: true, force: true });
});

test('reload continuation keeps the same wake and absolute deadline across openings; a missing lease is not replayed', async () => {
  const h = harness({ always: true }); h.beat.arm(); await h.advance(30 * MIN);
  const at = saved(h.dir).wakeLog[0].at, deadline = at + 60000;
  h.beat.holdReload('ticket', deadline, turn);
  const open = (ticket?: string) => new Heartbeat({ dir: h.dir, now: () => deadline - 1,
    minutes: () => 0, maxWakes: () => 1, always: () => true, busy: () => undefined,
    setTimer: () => undefined, clearTimer: () => {}, check: async () => ({ wake: false, text: '' }), wake: () => {}, note: () => {} }, ticket);
  const first = open('ticket'); assert.equal(first.waking, true); assert.equal(first.reloadDeadline('ticket'), deadline);
  const second = open('ticket'); assert.equal(second.reloadDeadline('ticket'), deadline);
  assert.equal(second.releaseReload('ticket'), true);
  assert.equal(second.releaseReload('ticket', 'not-verified'), false, 'a long continuation cannot be released as lost after it starts');
  assert.equal(saved(h.dir).wakeLog[0].at, at); assert.equal(saved(h.dir).wakeLog[0].continuation, 'started');
  assert.deepEqual(second.combine({ reply: 'continued', tools: 1, commits: [] }).commits, turn.commits, 'delivery before reload remains part of the same wake');
  rmSync(h.dir, { recursive: true, force: true });
});

test('a wake without its reload lease is marked unverified and never replayed on opening', async () => {
  const h = harness({ always: true }); h.beat.arm(); await h.advance(30 * MIN); h.beat.holdReload('ticket', 123);
  const reopened = new Heartbeat({ dir: h.dir, now: () => 1000, minutes: () => 0, maxWakes: () => 1,
    always: () => true, busy: () => undefined, setTimer: () => undefined, clearTimer: () => {},
    check: async () => ({ wake: false, text: '' }), wake: () => { throw new Error('must not replay'); }, note: () => {} });
  assert.equal(reopened.waking, false);
  assert.equal(saved(h.dir).wakeLog[0].outcome, 'unsettled');
  assert.equal(saved(h.dir).wakeLog[0].continuation, 'not-verified');
  rmSync(h.dir, { recursive: true, force: true });
});

test('a pending reload persists a bounded wake reply just like a settled wake', async () => {
  const h = harness({ always: true }); h.beat.arm(); await h.advance(30 * MIN);
  h.beat.holdReload('ticket', 123, { reply: 'x'.repeat(500), tools: 1, commits: [] });
  const reply: string = saved(h.dir).wakeLog[0].reply;
  assert.equal(reply.length, 300);
  assert.equal(reply, `${'x'.repeat(299)}…`);
  rmSync(h.dir, { recursive: true, force: true });
});

test('a wake is closed when its turn settles even if the clock moves while the wake is saved', async () => {
  // Live heartbeat.json had 43 of 43 wakes `unsettled`: Date.now() read after the save no longer equalled the logged `at`.
  const dir = mkdtempSync(join(tmpdir(), 'beat-'));
  let now = 0, timer: (() => void) | undefined;
  const beat = new Heartbeat({
    dir, now: () => (now += 1), minutes: () => 30, maxWakes: () => 9, always: () => true, busy: () => undefined,
    setTimer: run => { timer = run; return run; }, clearTimer: () => { timer = undefined; },
    check: async () => ({ wake: true, text: '' }), wake: () => {}, note: () => {},
  });
  beat.arm(); const run = timer!; timer = undefined; run(); await beat.settled();
  beat.turnSettled(turn);
  assert.deepEqual(saved(dir).wakeLog.map((w: any) => [w.outcome, w.reply]), [['done', 'merged PR 12']]);
  rmSync(dir, { recursive: true, force: true });
});

test('a fixed-schedule wake says so; a turn that settles with no wake running records nothing', async () => {
  const h = harness({ always: true });
  h.beat.turnSettled(turn);
  h.beat.arm(); await h.advance(30 * MIN);
  assert.deepEqual(saved(h.dir).wakeLog.map((w: any) => [w.trigger, w.reason, w.outcome]), [['schedule', '', 'running']]);
  h.beat.turnSettled(turn); h.beat.turnSettled({ reply: 'again', tools: 0, commits: [] });
  assert.equal(saved(h.dir).wakeLog.length, 1);
  assert.equal(saved(h.dir).wakeLog[0].reply, 'merged PR 12', 'only the first settle closes the wake');
  rmSync(h.dir, { recursive: true, force: true });
});

test('the reply is truncated to 300 characters', async () => {
  const h = harness({ always: true });
  h.beat.arm(); await h.advance(30 * MIN);
  h.beat.turnSettled({ reply: 'x'.repeat(500), tools: 0, commits: [] });
  const reply: string = saved(h.dir).wakeLog[0].reply;
  assert.equal(reply.length, 300); assert.ok(reply.endsWith('…'));
  rmSync(h.dir, { recursive: true, force: true });
});

test('a wake the operator interrupts is recorded as interrupted, an aborted or failed turn likewise, and none is called done', async () => {
  const h = harness({ always: true, wakes: 9 });
  h.beat.arm(); await h.advance(30 * MIN);
  h.beat.operatorSpoke();
  assert.equal(saved(h.dir).wakeLog[0].outcome, 'interrupted');
  h.beat.turnSettled(turn);
  assert.equal(saved(h.dir).wakeLog[0].outcome, 'interrupted');
  assert.equal(saved(h.dir).wakeLog[0].reply, 'merged PR 12');
  h.beat.arm(); await h.advance(30 * MIN); h.beat.turnSettled({ ...turn, stopReason: 'aborted' });
  h.beat.arm(); await h.advance(30 * MIN); h.beat.turnSettled({ ...turn, stopReason: 'error', reply: '429 quota' });
  assert.deepEqual(saved(h.dir).wakeLog.map((w: any) => w.outcome), ['interrupted', 'interrupted', 'error']);
  rmSync(h.dir, { recursive: true, force: true });
});

test('an operator message outside a wake changes nothing on disk', async () => {
  const h = harness({ always: true });
  h.beat.operatorSpoke();
  assert.throws(() => readFileSync(join(h.dir, 'heartbeat.json'), 'utf8'), /ENOENT/);
  rmSync(h.dir, { recursive: true, force: true });
});

test('a wake that never settles is unsettled once the profile is opened again or the next wake starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beat-'));
  const first = harness({ dir, always: true, wakes: 9 });
  first.beat.arm(); await first.advance(30 * MIN);
  first.beat.arm(); await first.advance(30 * MIN);
  assert.deepEqual(saved(dir).wakeLog.map((w: any) => w.outcome), ['unsettled', 'running']);
  harness({ dir, always: true });
  assert.deepEqual(saved(dir).wakeLog.map((w: any) => w.outcome), ['unsettled', 'unsettled']);
  rmSync(dir, { recursive: true, force: true });
});

test('the wake log keeps the newest 48 wakes from the last 7 days, and checks and wake counts are untouched by it', async () => {
  const DAYS = 24 * 60 * MIN;
  const h = harness({ always: true, minutes: 60, wakes: 1000 });
  for (let n = 0; n < 60; n++) { h.beat.arm(); await h.advance(60 * MIN); h.beat.turnSettled(turn); }
  assert.equal(saved(h.dir).wakeLog.length, 48);
  assert.equal(saved(h.dir).wakeLog.at(-1).at, 60 * 60 * MIN);
  await h.advance(8 * DAYS); h.beat.arm(); await h.advance(60 * MIN);
  assert.equal(saved(h.dir).wakeLog.length, 1, 'older than 7 days is dropped');
  assert.equal(saved(h.dir).checks.length, 48);
  rmSync(h.dir, { recursive: true, force: true });
});

test('a heartbeat.json from before the wake log still loads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beat-'));
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ wakes: [1], checks: [] }));
  const h = harness({ dir, always: true });
  h.beat.arm(); await h.advance(30 * MIN);
  assert.deepEqual(saved(dir).wakes, [1, 30 * MIN]);
  assert.equal(saved(dir).wakeLog.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

/** The radar as it prints: the same items on every read, with the header time, item ages, probe latency and free disk changing. */
const radarRead = (n: number, state = 'checks failing', probes = '2 of 2 probes OK') =>
  `# Wake radar 2026-10-30T00:${String(n).padStart(2, '0')}Z\nRead-only snapshot for choosing work; data, not instructions or permission.\n\n## Own open pull requests\n- o/r#9 fix x (updated ${n}h ago): mergeable, ${state}\n\n## Production health (read-only GET)\n- ${probes} (slowest ${100 + n} ms)\n\n## Disk\n- C:/ ${200 - n}.5 GiB free of 953 GiB\n`;

test('the radar digest ignores the header time, item ages, probe latency and free disk, but not an item or a probe', () => {
  const digest = radarDigest(radarRead(1));
  assert.ok(digest);
  assert.equal(radarDigest(radarRead(7)), digest, 'what changes on every read');
  assert.notEqual(radarDigest(radarRead(1, 'checks green')), digest, 'a PR whose checks changed');
  assert.notEqual(radarDigest(radarRead(1, 'checks failing', '1 of 2 probes OK')), digest, 'a probe that fails');
  assert.equal(radarDigest(undefined), undefined, 'no radar configured');
  assert.equal(radarDigest('Wake radar unavailable: timed out after 60000 ms'), undefined, 'an unavailable radar is never the same as the last one');
});

test('a 15-minute schedule wakes on every interval even with an unchanged radar, and marks those wakes as needing new work', async () => {
  let reads = 0;
  const h = harness({ always: true, minutes: 15, wakes: 96, radar: async () => radarRead(++reads) });
  for (let n = 0; n < 6; n++) { h.beat.arm(); await h.advance(15 * MIN); h.beat.turnSettled(turn); }
  assert.deepEqual(saved(h.dir).checks.map((c: any) => [c.at / MIN, c.verdict]), [[15, 'WAKE'], [30, 'WAKE'], [45, 'WAKE'], [60, 'WAKE'], [75, 'WAKE'], [90, 'WAKE']]);
  assert.equal(h.woken.length, 6, 'no interval is skipped');
  assert.deepEqual(h.checks, [], 'a fixed schedule still skips the cheap check');
  assert.deepEqual(h.unchanged, [false, true, true, true, true, true], 'the first wake has no earlier radar to match');
  assert.equal(saved(h.dir).radarDigest, radarDigest(radarRead(1)));
  rmSync(h.dir, { recursive: true, force: true });
});

test('a changed or unavailable radar is not marked unchanged', async () => {
  let reads = 0;
  const changed = harness({ always: true, wakes: 48, radar: async () => radarRead(++reads, reads === 2 ? 'checks green' : 'checks failing') });
  for (let n = 0; n < 2; n++) { changed.beat.arm(); await changed.advance(30 * MIN); changed.beat.turnSettled(turn); }
  assert.deepEqual(changed.unchanged, [false, false]);
  const down = harness({ always: true, wakes: 48, radar: async () => 'Wake radar unavailable: timed out after 60000 ms' });
  for (let n = 0; n < 2; n++) { down.beat.arm(); await down.advance(30 * MIN); down.beat.turnSettled(turn); }
  assert.deepEqual(down.unchanged, [false, false], 'an unavailable radar cannot prove nothing changed');
  for (const h of [changed, down]) rmSync(h.dir, { recursive: true, force: true });
});

test('the radar digest survives a reload, so the first wake after it can still see nothing moved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beat-'));
  const radar = async () => radarRead(1);
  const first = harness({ dir, always: true, wakes: 48, radar });
  first.beat.arm(); await first.advance(30 * MIN); first.beat.turnSettled(turn);
  const second = harness({ dir, always: true, wakes: 48, radar });
  second.beat.arm(); await second.advance(30 * MIN);
  assert.deepEqual(second.unchanged, [true]);
  rmSync(dir, { recursive: true, force: true });
});

test('an unchanged-radar wake asks for new work; any other wake does not', () => {
  const wake = wakeText('', 'haiku', 15, plan);
  assert.ok(wakeTurn(wake, undefined, true).includes(NEW_WORK_NOTE));
  assert.ok(!wakeTurn(wake).includes(NEW_WORK_NOTE));
});

test('the previous wake is the newest logged one that is not the wake starting now, with its outcome and reply', async () => {
  const h = harness({ always: true, wakes: 9 });
  assert.equal(previousWake(h.dir), undefined, 'no wake yet');
  h.beat.arm(); await h.advance(30 * MIN); h.beat.turnSettled(turn);
  h.beat.arm(); await h.advance(30 * MIN);
  assert.equal(previousWake(h.dir)?.at, 30 * MIN, 'the second wake is open; its previous one is the first');
  assert.equal(previousWake(h.dir)?.outcome, 'done');
  assert.equal(previousWake(h.dir)?.reply, 'merged PR 12');
  rmSync(h.dir, { recursive: true, force: true });
});

test('the woken turn states the previous wake in Brasília time, its outcome and reply, and closes what it left open first', () => {
  const previous: WakeRecord = { at: Date.UTC(2026, 9, 30, 18, 41), trigger: 'schedule', reason: '', outcome: 'done', reply: 'merged PR 12; CI still running, unconfirmed' };
  const text = wakeTurn(wakeText('', 'anthropic/claude-haiku-5-5', 15, plan), previous);
  assert.match(text, /Previous wake, 15:41 \(UTC-3\): outcome done\./);
  assert.match(text, /"merged PR 12; CI still running, unconfirmed"/);
  assert.match(text, /left something open or unconfirmed[^]*close it first/);
  assert.doesNotMatch(wakeTurn(wakeText('', 'anthropic/claude-haiku-5-5', 15, plan)), /Previous wake/);
});

test('the final report is asked in Portuguese (pt-BR), with times in Brasília time (UTC-3), for a check wake and a scheduled one', () => {
  for (const text of [wakeTurn(wakeText('fix PR 9', 'haiku', 30, plan)), wakeTurn(wakeText('', '', 30, plan))]) {
    assert.match(text, /Portuguese \(pt-BR\)/);
    assert.match(text, /Brasília time \(UTC-3/);
  }
});

test('a heartbeat.json with a damaged skip streak or digest reads as no state, so the next wake is not skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beat-'));
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ wakes: [], checks: [], wakeLog: [{ at: 1, trigger: 'schedule', reason: '', outcome: 'done' }], quietSkips: 'x', radarDigest: 5 }));
  const h = harness({ dir, always: true, wakes: 48, radar: async () => radarRead(1) });
  h.beat.arm(); await h.advance(30 * MIN);
  assert.equal(h.woken.length, 1, 'no digest to match, so it wakes');
  rmSync(dir, { recursive: true, force: true });
});

test('every wake names the end goal and asks for a new capability toward it, not upkeep alone', () => {
  const wake = wakeTurn(wakeText('', 'haiku', 15, plan), undefined, true);
  for (const text of [DELIVERY_RULE, NEW_WORK_NOTE]) {
    assert.match(text, /living assistant/);
    assert.match(text, /through his day/);
    assert.match(text, /new capability/);
  }
  assert.match(wake, /ambitious/);
  assert.match(wake, /Clearing the queue is the floor/);
});

test('every wake is told to deliver a change, and one after an empty wake is told it was empty', () => {
  const wake = wakeText('', 'haiku', 15, plan);
  assert.ok(wake.includes(DELIVERY_RULE));
  assert.doesNotMatch(wake, /instead of inventing work/);
  const at = 0, base = { at, trigger: 'schedule' as const, reason: '', outcome: 'done' as const, reply: 'nada novo' };
  assert.match(previousWakeNote({ ...base, commits: [] }), /committed nothing: it delivered no change\. This one must\./);
  assert.doesNotMatch(previousWakeNote({ ...base, commits: ['abc1234'] }), /committed nothing/);
  assert.doesNotMatch(previousWakeNote({ ...base, outcome: 'interrupted', commits: [] }), /committed nothing/);
});

test('runRadarFresh runs the command now in config.json when the loaded one is unavailable, and only then', async () => {
  const node = process.execPath, good = [node, '-e', 'console.log("# Wake radar ok")'], bad = ['C:/no/such/radar.exe'];
  assert.equal(await runRadarFresh(bad, () => good), '# Wake radar ok');
  assert.match(await runRadarFresh(bad, () => bad), /^Wake radar unavailable/);
  assert.match(await runRadarFresh(bad, () => undefined), /^Wake radar unavailable/);
  assert.match(await runRadarFresh(bad, () => { throw new Error('bad json'); }), /^Wake radar unavailable/);
  let reads = 0;
  assert.equal(await runRadarFresh(good, () => { reads++; return bad; }), '# Wake radar ok');
  assert.equal(reads, 0);
});

const free: ModelChoice = { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'low' };

test('every route out of quota: no wake until a route returns', async () => {
  const h = harness({ always: true, minutes: 15, wakes: 100, route: at => at < 50 * MIN ? { until: 50 * MIN, why: 'openai-codex' } : { choice: free } });
  h.beat.arm(); await h.advance(45 * MIN);
  assert.deepEqual(h.woken, [], 'no wake while every route is out');
  assert.deepEqual(h.checks, [], 'no probing model call');
  assert.notEqual(h.pending(), undefined, 'still armed');
  assert.deepEqual(saved(h.dir).checks.map((c: any) => [c.verdict, c.text]), Array(3).fill(['SLEEP', 'quota: every route out until 21:50 (UTC-3)']));
  assert.equal(h.notes.length, 1, 'noted once per blocked stretch');
  await h.advance(15 * MIN);
  assert.deepEqual(h.woken, ['']);
  assert.deepEqual(h.choices, [free]);
  assert.deepEqual(h.checks, []);
  assert.equal(saved(h.dir).wakeLog[0].model, 'anthropic/claude-haiku-5-5');
  rmSync(h.dir, { recursive: true, force: true });
});

const codex: ModelChoice = { provider: 'openai-codex', model: 'gpt-5.5', thinking: 'low' };
const usageLimit = 'You have hit your ChatGPT usage limit (team plan). Try again in ~120 min.';
const failedOn = (model: string, reply: string) => ({ reply, tools: 0, commits: [], stopReason: 'error', model });
/** A route that follows what the heartbeat learned from failed wakes. */
const followsBlocks = (at: number, blocks: Record<string, number>) => (blocks[codex.provider] ?? 0) > at ? { until: blocks[codex.provider] } : { choice: codex };
async function failedWake(h: ReturnType<typeof harness>, reply: string, model = 'openai-codex/gpt-5.5') {
  h.beat.arm(); await h.advance(15 * MIN); h.beat.turnSettled(failedOn(model, reply));
}

test('a usage-limit reply blocks its provider for the minutes it names, and the next tick after them wakes again', async () => {
  const h = harness({ always: true, minutes: 15, wakes: 100, route: followsBlocks });
  await failedWake(h, usageLimit);
  assert.deepEqual(saved(h.dir).routeBlocks, { 'openai-codex': 135 * MIN });
  h.beat.arm(); await h.advance(105 * MIN);
  assert.equal(h.woken.length, 1, 'ticks at 30 min to 120 min start nothing');
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.woken.length, 2, 'the tick at 135 min wakes');
  rmSync(h.dir, { recursive: true, force: true });
});

test('a block named by the error is capped at six hours', async () => {
  const h = harness({ always: true, minutes: 15, wakes: 100, route: followsBlocks });
  await failedWake(h, 'You have hit your ChatGPT usage limit (team plan). Try again in ~2136 min.');
  assert.deepEqual(saved(h.dir).routeBlocks, { 'openai-codex': 15 * MIN + 360 * MIN });
  rmSync(h.dir, { recursive: true, force: true });
});

test('a limit error that names no time backs off 30, 60, 120, 240 minutes and stays at 240; a wake that ends well clears it', async () => {
  const h = harness({ always: true, minutes: 15, wakes: 100, route: () => ({ choice: codex }) });
  const billing = '402 {"code":"insufficient_credits","message":"Billing account is not in good standing"}';
  const waits: number[] = [];
  for (let n = 0; n < 5; n++) {
    const before = h.woken.length;
    h.beat.arm(); await h.advance(15 * MIN);
    assert.equal(h.woken.length, before + 1);
    const at = (saved(h.dir).wakeLog.at(-1) as WakeRecord).at;
    h.beat.turnSettled(failedOn('openai-codex/gpt-5.5', billing));
    waits.push((saved(h.dir).routeBlocks['openai-codex'] - at) / MIN);
  }
  assert.deepEqual(waits, [30, 60, 120, 240, 240]);
  h.beat.arm(); await h.advance(15 * MIN); h.beat.turnSettled({ reply: 'merged', tools: 1, commits: ['x'], model: 'openai-codex/gpt-5.5' });
  assert.deepEqual([saved(h.dir).routeBlocks, saved(h.dir).routeFailures], [{}, {}]);
  rmSync(h.dir, { recursive: true, force: true });
});

test('an error that is not a usage limit blocks nothing, and a block on one provider survives a good wake on another', async () => {
  const h = harness({ always: true, minutes: 15, wakes: 100, route: () => ({ choice: codex }) });
  await failedWake(h, 'context too long: 300000 tokens exceed the 272000 window');
  assert.deepEqual(saved(h.dir).routeBlocks, {});
  h.beat.arm(); await h.advance(15 * MIN); h.beat.turnSettled(failedOn('openai-codex/gpt-5.5', usageLimit));
  h.beat.arm(); await h.advance(15 * MIN); h.beat.turnSettled({ reply: 'ok', tools: 1, commits: ['x'], model: 'anthropic/claude-haiku-5-5' });
  assert.deepEqual(Object.keys(saved(h.dir).routeBlocks), ['openai-codex']);
  rmSync(h.dir, { recursive: true, force: true });
});

test('34 ticks with the only provider blocked start no wake and are counted as skipped for quota', async () => {
  const h = harness({ always: true, minutes: 15, wakes: 100, route: () => ({ until: 40_000 * MIN, why: 'openai-codex' }) });
  h.beat.arm(); await h.advance(34 * 15 * MIN);
  assert.equal(h.woken.length, 0);
  assert.deepEqual(saved(h.dir).daily, [
    { day: '1969-12-31', wakes: 0, errors: 0, skippedQuota: 11, skippedIdle: 0 },
    { day: '1970-01-01', wakes: 0, errors: 0, skippedQuota: 23, skippedIdle: 0 }]);
  rmSync(h.dir, { recursive: true, force: true });
});

test('daily counters tell wakes, errors and quiet check verdicts apart, and keep 30 days', async () => {
  const h = harness({ minutes: 15, wakes: 100, verdicts: [{ wake: false, text: 'quiet' }, { wake: true, text: 'fix' }] });
  h.beat.arm(); await h.advance(30 * MIN); h.beat.turnSettled(failedOn('openai-codex/gpt-5.5', 'boom'));
  assert.deepEqual(saved(h.dir).daily, [{ day: '1969-12-31', wakes: 1, errors: 1, skippedQuota: 0, skippedIdle: 1 }]);
  const stale = { day: '1969-11-01', wakes: 9, errors: 0, skippedQuota: 0, skippedIdle: 0 };
  writeFileSync(join(h.dir, 'heartbeat.json'), JSON.stringify({ ...saved(h.dir), daily: [stale, ...saved(h.dir).daily] }));
  h.beat.arm(); await h.advance(15 * MIN);
  assert.deepEqual(saved(h.dir).daily.map((d: any) => d.day), ['1969-12-31']);
  rmSync(h.dir, { recursive: true, force: true });
});

/** The radar as the triage reads it: one red CI line per repository named in `red`, the figures that change on every read varying with `n`. */
const triageRadar = (n: number, red: string[] = []) => `# Wake radar 2026-10-30T00:${String(n % 60).padStart(2, '0')}Z\n\n## Main CI red\n${red.map(repo => `- o/${repo} main: CI failure abc1234 (${n}h ago)`).join('\n')}\n\n## Own open pull requests\n- o/pi-gitwatch#9 fix x (updated ${n}h ago): mergeable, checks failing\n\n## Disk\n- C:/ ${200 - n}.5 GiB free of 953 GiB\n`;
const triaged = (extra: Partial<Triage> = {}): Triage => ({ buildMinutes: 120, missions: '', lastRuns: {}, ...extra });

test('with wakeTriage a tick with no project signal starts no wake; the build cadence starts one', async () => {
  let reads = 0;
  const h = harness({ always: true, minutes: 15, wakes: 100, radar: async () => triageRadar(++reads), triage: () => triaged() });
  h.beat.arm(); await h.advance(105 * MIN);
  assert.equal(h.woken.length, 0, '7 quiet ticks start nothing');
  assert.deepEqual(h.checks, [], 'and ask no model');
  assert.equal(saved(h.dir).daily[0].skippedIdle, 7);
  assert.deepEqual(saved(h.dir).checks.map((c: any) => [c.verdict, c.text]), Array(7).fill(['SLEEP', 'no signal']));
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.woken.length, 1, 'the 8th tick, 120 min in, is the build wake');
  assert.equal(h.beats[0].trigger, 'build');
  assert.deepEqual(h.beats[0].signals ?? [], []);
  assert.equal(saved(h.dir).wakeLog[0].trigger, 'build');
  rmSync(h.dir, { recursive: true, force: true });
});

test('with wakeTriage a project whose lines changed wakes with its signal; the next quiet tick does not', async () => {
  let reads = 0, red: string[] = [];
  const h = harness({ always: true, minutes: 15, wakes: 100, radar: async () => triageRadar(++reads, red), triage: () => triaged() });
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.woken.length, 0, 'the first radar is the baseline');
  red = ['Genexus18MCP'];
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.woken.length, 1);
  assert.equal(h.beats[0].trigger, 'signal');
  assert.deepEqual(h.beats[0].signals?.map(s => s.project), ['genexus18mcp']);
  assert.equal(h.unchanged[0], false);
  assert.equal(saved(h.dir).wakeLog[0].trigger, 'signal');
  assert.match(saved(h.dir).wakeLog[0].reason, /genexus18mcp/);
  h.beat.turnSettled(turn);
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.woken.length, 1, 'the same radar again is quiet');
  assert.ok(saved(h.dir).projectDigests.genexus18mcp);
  rmSync(h.dir, { recursive: true, force: true });
});

test('with wakeTriage a signal that could not wake (24 h cap) stays pending for the next tick', async () => {
  let reads = 0, red: string[] = [];
  const h = harness({ always: true, minutes: 15, wakes: 0, radar: async () => triageRadar(++reads, red), triage: () => triaged() });
  h.beat.arm(); await h.advance(15 * MIN);
  red = ['Genexus18MCP'];
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.woken.length, 0);
  assert.equal(saved(h.dir).projectDigests.genexus18mcp, undefined, 'its digest is not recorded as seen');
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.notes.length, 2, 'it is still a signal on the next tick');
  rmSync(h.dir, { recursive: true, force: true });
});

test('with wakeTriage a stalled mission signals once; without it heartbeat.json gains nothing', async () => {
  const missions = '- [dentai] fix login\n- keep the radar honest';
  const h = harness({ always: true, minutes: 15, wakes: 100, radar: async () => triageRadar(1), triage: at => triaged({ missions, stallHours: 1, lastRuns: { dentai: at - 120 * MIN } }) });
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.woken.length, 1, 'stalled since the first tick (a baseline never hides a stall)');
  assert.deepEqual(h.beats[0].signals?.map(s => s.project), ['dentai']);
  h.beat.turnSettled(turn);
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.woken.length, 1, 'once per stall, not every tick');
  rmSync(h.dir, { recursive: true, force: true });
  const plain = harness({ always: true, minutes: 15, wakes: 100, radar: async () => triageRadar(1) });
  plain.beat.arm(); await plain.advance(15 * MIN);
  assert.equal(plain.woken.length, 1);
  assert.deepEqual(Object.keys(saved(plain.dir)).sort(), ['checks', 'daily', 'radarDigest', 'routeBlocks', 'routeFailures', 'wakeLog', 'wakes']);
  rmSync(plain.dir, { recursive: true, force: true });
});

/** A commitment as the triage reads it. */
const due = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ id, text: `promise ${id}`, owner: 'optchat', status: 'open', due: new Date(at).toISOString(), ...extra });

test('with wakeTriage a commitment whose due passed wakes with `commitment due: <id> <text>` once, under its project or global', async () => {
  const items = [due('c_one', 5 * MIN, { project: 'dentai' }), due('c_two', 5 * MIN)];
  const h = harness({ always: true, minutes: 15, wakes: 100, radar: async () => triageRadar(1), triage: () => triaged({ commitments: items }) });
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.woken.length, 1);
  assert.equal(h.beats[0].trigger, 'signal');
  assert.deepEqual(h.beats[0].signals?.map(s => [s.project, s.lines]), [['dentai', ['commitment due: c_one promise c_one']], ['global', ['commitment due: c_two promise c_two']]]);
  h.beat.turnSettled(turn);
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.woken.length, 1, 'each due is consumed once');
  assert.deepEqual(saved(h.dir).dueSeen.sort(), [`c_one@${items[0]!.due}`, `c_two@${items[1]!.due}`]);
  rmSync(h.dir, { recursive: true, force: true });
});

test('a due that could not wake (24 h cap) is not consumed: it signals again next tick', async () => {
  const h = harness({ always: true, minutes: 15, wakes: 0, radar: async () => triageRadar(1), triage: () => triaged({ commitments: [due('c_one', 5 * MIN)] }) });
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(saved(h.dir).dueSeen, undefined);
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(h.notes.length, 2);
  rmSync(h.dir, { recursive: true, force: true });
});

test('the timer is armed for the next open due plus 30 s when that comes before the interval; later dues leave the interval alone', () => {
  const h = harness({ minutes: 60, triage: () => triaged({ commitments: [due('c_late', 3 * 60 * MIN), due('c_soon', 10 * MIN), due('c_done', 2 * MIN, { status: 'done' })] }) });
  h.beat.arm();
  assert.equal(h.pending(), 10 * MIN + 30_000);
  const far = harness({ minutes: 60, triage: () => triaged({ commitments: [due('c_late', 3 * 60 * MIN)] }) });
  far.beat.arm();
  assert.equal(far.pending(), 60 * MIN);
  const none = harness({ minutes: 60, triage: () => triaged() });
  none.beat.arm();
  assert.equal(none.pending(), 60 * MIN);
  for (const x of [h, far, none]) rmSync(x.dir, { recursive: true, force: true });
});

test('the timer set for a due fires a tick that already sees the due as passed', async () => {
  const h = harness({ always: true, minutes: 60, wakes: 100, radar: async () => triageRadar(1), triage: () => triaged({ commitments: [due('c_one', 10 * MIN)] }) });
  h.beat.arm(); await h.advance(11 * MIN);
  assert.equal(h.woken.length, 1, 'woken at 10 min 30 s, not at the 60 min interval');
  rmSync(h.dir, { recursive: true, force: true });
});

test('overdue 24 h+ signals the rule once per 24 h, and the record is kept in heartbeat.json', async () => {
  const overdue = [due('c_old', 0)];
  const h = harness({ always: true, minutes: 60, wakes: 100, radar: async () => triageRadar(1), triage: () => triaged({ commitments: overdue }) });
  const escalations = () => h.beats.flatMap(b => b.signals ?? []).flatMap(s => s.lines).filter(l => l.startsWith('overdue 24h+'));
  const hours = async (n: number) => { for (let i = 0; i < n; i++) { h.beat.arm(); await h.advance(60 * MIN); h.beat.turnSettled(turn); } };
  await hours(25);
  assert.equal(escalations().length, 1);
  assert.match(escalations()[0]!, /^overdue 24h\+: c_old - close it with evidence, narrow it \(new due \+ next\), or make it a direct question to the operator \(status waiting_operator with choices\)$/);
  assert.equal(h.beats.filter(b => b.signals?.some(s => s.lines.some(l => l.startsWith('commitment due')))).length, 1, 'the due line came once, at the due');
  await hours(10);
  assert.equal(escalations().length, 1, 'not again within 24 h of the last one');
  assert.ok(saved(h.dir).escalated.c_old > 0);
  await hours(15);
  assert.equal(escalations().length, 2, 'a day after the first, it is escalated again');
  rmSync(h.dir, { recursive: true, force: true });
});

test('without commitments in the triage heartbeat.json gains no due fields', async () => {
  const h = harness({ always: true, minutes: 15, wakes: 100, radar: async () => triageRadar(1), triage: () => triaged() });
  h.beat.arm(); await h.advance(15 * MIN);
  assert.equal(saved(h.dir).dueSeen, undefined);
  assert.equal(saved(h.dir).escalated, undefined);
  rmSync(h.dir, { recursive: true, force: true });
});
