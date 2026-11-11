import './support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children, PARK_NOTE_MS } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { parkUntil, quotaError, QuotaOutage, untilText } from '../src/quota-hold.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

// 19:00Z is 16:00 in Brasília.
const START = Date.UTC(2025, 10, 10, 19, 0, 0);
const MIN = 60_000;
const HINT = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Try again in ~60 min"}}';

// Retries inside Pi would only delay the quota error these tests are about.
mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));

const nap = (ms = 25) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, label = 'condition') {
  const deadline = Date.now() + 6000;
  while (!condition()) { if (Date.now() > deadline) assert.fail(`Timed out: ${label}`); await nap(10); }
}

/** A clock the test moves by hand: timers run, in order, as time passes. */
function fakeClock() {
  let now = START, seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const callbacks: (() => void)[] = [];
  return {
    callbacks,
    now: () => now,
    setTimer: (run: () => void, ms: number) => { const handle = ++seq; callbacks.push(run); timers.set(handle, { at: now + ms, run }); return handle; },
    clearTimer: (handle: unknown) => { timers.delete(handle as number); },
    get pending() { return timers.size; },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = Math.max(now, next[1].at); next[1].run(); await nap();
      }
      now = end; await nap();
    },
  };
}

type Verdict = 'limit' | 'ok';
type TestControl = { wait?: Promise<void>; hold?: Promise<void>; fail?: boolean; secondLimit?: boolean };
function syntheticStream(provider: string, control: TestControl, seen: string[][], routes: string[], calls: Map<string, number>, verdict: (task: string, call: number) => Verdict): NonNullable<Parameters<ModelRuntime['registerProvider']>[1]['streamSimple']> {
  return (model, context) => {
      routes.push(model.provider);
      const task = textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
      const call = (calls.get(task) ?? 0) + 1; calls.set(task, call);
      seen.push(context.messages.map(m => `${m.role}:${textContent(m.role === 'toolResult' ? [] : m.content as never).slice(0, 60)}`));
      const stream = createAssistantMessageEventStream();
      const base = { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
      const limited = provider === 'quota-test-2' ? control.secondLimit : verdict(task, call) === 'limit';
      const message: AssistantMessage = limited ? { ...base, role: 'assistant', content: [], stopReason: 'error', errorMessage: HINT }
        : provider === 'quota-test' && task === 'tooly' && call === 1 ? { ...base, role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'date', arguments: {} }], stopReason: 'toolUse' }
        : { ...base, role: 'assistant', content: [{ type: 'text', text: `Finished ${task}` }], stopReason: 'stop' };
      queueMicrotask(() => { void (control.hold ?? Promise.resolve()).then(() => {
        if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
        else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
        stream.end();
      }); });
      return stream;
  };
}
function installProviders(runtime: ModelRuntime, control: TestControl, seen: string[][], routes: string[], calls: Map<string, number>, verdict: (task: string, call: number) => Verdict) {
  for (const provider of ['quota-test', 'quota-test-2']) runtime.registerProvider(provider, { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple: syntheticStream(provider, control, seen, routes, calls, verdict) });
}
/** Workers on a synthetic provider whose answer the test chooses per task: out of quota, or a short answer (`tooly` first calls a tool). */
async function rig(t: { after(fn: () => void | Promise<void>): void }, block: { until?: number } = {}, verdict: (task: string, call: number) => Verdict = () => 'limit') {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-quota-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const reports: string[] = [], warnings: string[] = [], calls = new Map<string, number>(), seen: string[][] = [], routes: string[] = [];
  const control: TestControl = {};
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  installProviders(runtime, control, seen, routes, calls, verdict);
  const build = (clock: ReturnType<typeof fakeClock>) => {
    const made = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'quota-test', model: 'child', thinking: 'off' }), () => '',
      async text => { reports.push(text); }, text => warnings.push(text), dir,
      { settings: () => ({ subagentLevels: 1, maxAgents: 8 }), parentSession: 'parent', clock,
        quotaBlock: provider => provider === 'quota-test' && block.until !== undefined && block.until > clock.now() ? block.until : undefined,
        createSession: async options => { if (control.wait) await control.wait; if (control.fail) throw new Error('synthetic session failure'); return createAgentSession({ ...options, modelRuntime: runtime }); } });
    opened.push(made);
    return made;
  };
  const opened: Children[] = [], clock = fakeClock(), children = build(clock);
  t.after(async () => { for (const made of opened) await made.close(); removeDir(dir); });
  return { children, clock, reports, warnings, calls, seen, routes, dir, build, control, runtime };
}

const failures = (reports: string[]) => reports.filter(text => /Task error|failed|Task aborted/i.test(text));

test('four workers that hit 429 on their first request are parked, not reported as failed, and run again after the reset', async t => {
  let limited = true;
  const h = await rig(t, {}, () => limited ? 'limit' : 'ok');
  const ids = await h.children.spawn([{ task: 'a' }, { task: 'b' }, { task: 'c' }, { task: 'd' }], h.dir);
  await until(() => ids.every(id => h.children.history.records.get(id)?.parked), 'all four parked');
  assert.deepEqual(failures(h.reports), [], 'no failure report');
  assert.ok(ids.every(id => h.children.history.records.get(id)?.state === 'interrupted'));
  assert.equal(h.reports.length, 0, 'nothing is told while more workers may still park');
  await h.clock.advance(PARK_NOTE_MS);
  assert.equal(h.reports.length, 1, 'one message for the four workers');
  assert.match(h.reports[0], /^\[quota\]/);
  for (const id of ids) assert.ok(h.reports[0].includes(id), `names ${id}`);
  assert.match(h.reports[0], /17:0\d \(Bras/, 'the hinted reset (60 min, plus the margin), in Brasília time');
  const calls = [...h.calls.values()].reduce((sum, n) => sum + n, 0);
  limited = false;
  await h.clock.advance(55 * MIN);
  assert.equal([...h.calls.values()].reduce((sum, n) => sum + n, 0), calls, 'nothing runs before the reset');
  await h.clock.advance(7 * MIN);
  await until(() => ids.every(id => h.children.history.records.get(id)?.state === 'completed'), 'all four completed after the reset');
  assert.deepEqual(failures(h.reports), []);
  assert.equal(h.reports.length, 5, 'the outage note and one report per worker');
  for (const id of ids) assert.ok(h.reports.some(text => text.startsWith(`[${id}]`) && text.includes('Finished')), `${id} reported its result under its own id`);
  assert.ok(ids.every(id => h.children.history.records.get(id)?.parked === undefined));
});

test('a quota-parked writer can resume itself but excludes another writer', async t => {
  let limited = true;
  const h = await rig(t, {}, () => limited ? 'limit' : 'ok');
  const repo = join(h.dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const task = 'Goal: test\nAcceptance: done\nEvidence: test\nAuthority: local only';
  const [id] = await h.children.spawn([{ task, kind: 'code', model: 'quota-test/child', cwd: repo }], h.dir);
  await until(() => !!h.children.history.records.get(id)?.parked && !h.children.live(id), 'writer parked');
  await assert.rejects(() => h.children.spawn([{ task, kind: 'code', model: 'quota-test/child', cwd: repo }], h.dir), /One writer per repo/);
  limited = false;
  await h.children.tell(id, 'continue');
  await until(() => h.children.history.records.get(id)?.state === 'completed', 'same writer completed');
});

test('explicit unavailable routing leaves the parked worker and its wake intact', async t => {
  const h = await rig(t, {}, () => 'limit');
  const [id] = await h.children.spawn([{ task: 'route-validation' }], h.dir);
  await until(() => !!h.children.history.records.get(id)?.parked && !h.children.live(id), 'parked');
  const before = structuredClone(h.children.history.records.get(id));
  const tell = h.children.tell.bind(h.children) as (...args: unknown[]) => Promise<string>;
  await assert.rejects(() => tell(id, 'continue', 'manager', undefined, false, { model: 'missing-provider/missing' }), /not available/i);
  assert.deepEqual(h.children.history.records.get(id), before);
  assert.ok(h.clock.pending > 0);
});

test('retarget keeps the transcript, fences old quota callbacks and persists the selected route', async t => {
  const h = await rig(t, {}, (task, call) => task === 'tooly' && call === 1 ? 'ok' : 'limit');
  const [id] = await h.children.spawn([{ task: 'tooly' }], h.dir);
  await until(() => !!h.children.history.records.get(id)?.parked && !h.children.live(id), 'parked after tool');
  const before = structuredClone(h.children.history.records.get(id));
  const wake = h.clock.callbacks[0];
  const internals = h.children as unknown as { parkGeneration: Map<string, number>; retryPark(id: string, error: unknown, generation: number): Promise<void> };
  const oldGeneration = internals.parkGeneration.get(id)!;
  await assert.rejects(() => h.children.tell(id, 'continue', 'manager', undefined, false, { model: 'quota-test-2/child', thinking: 'high' }), /Thinking level/);
  assert.deepEqual(h.children.history.records.get(id), before);
  const answer = await h.children.tell(id, 'continue', 'manager', undefined, false, { model: 'quota-test-2/child', thinking: 'off' });
  assert.match(answer, /quota-test-2\/child \(off\)/);
  await until(() => h.children.history.records.get(id)?.state === 'completed', 'retarget completed');
  assert.equal(h.children.history.records.get(id)?.model, 'quota-test-2/child');
  assert.ok(h.seen.at(-1)?.some(line => line.startsWith('toolResult')), 'earlier tool result survives');
  const saved = structuredClone(h.children.history.records.get(id));
  const count = h.routes.length;
  wake();
  await internals.retryPark(id, new Error('stale'), oldGeneration);
  await nap();
  assert.equal(h.routes.length, count, 'old callback did not dispatch');
  assert.deepEqual(h.children.history.records.get(id), saved, 'old retry did not mutate the new run');
  await h.children.close();
  const reloaded = h.build(h.clock);
  assert.equal(reloaded.history.records.get(id)?.model, 'quota-test-2/child');
  assert.equal(reloaded.history.records.get(id)?.thinking, 'off');
  await reloaded.tell(id, 'after reload');
  await until(() => reloaded.history.records.get(id)?.state === 'completed', 'completed after reload');
  assert.equal(h.routes.at(-1), 'quota-test-2');
});

test('an explicit no-op route continues once with the same identity and conversation', async t => {
  const h = await rig(t, {}, () => 'ok');
  const [id] = await h.children.spawn([{ task: 'no-op' }], h.dir);
  await until(() => h.children.history.records.get(id)?.state === 'completed' && !h.children.live(id), 'completed');
  const before = structuredClone(h.children.history.records.get(id)!);
  await h.children.tell(id, 'continue', 'manager', undefined, false, { model: 'quota-test/child', thinking: 'off' });
  await until(() => h.children.history.records.get(id)?.state === 'completed' && !h.children.live(id), 'continued');
  const after = h.children.history.records.get(id)!;
  assert.equal(after.id, before.id); assert.equal(after.cwd, before.cwd); assert.equal(after.sessionFile, before.sessionFile);
  assert.equal(h.routes.length, 2);
  assert.ok(h.seen.at(-1)?.some(line => line.includes('Finished no-op')));
});

test('an old retry cannot change a new generation parked on the replacement account', async t => {
  const h = await rig(t, {}, () => 'limit');
  const [id] = await h.children.spawn([{ task: 'two outages' }], h.dir);
  await until(() => !!h.children.history.records.get(id)?.parked && !h.children.live(id), 'first outage');
  const internals = h.children as unknown as { parkGeneration: Map<string, number>; retryPark(id: string, error: unknown, generation: number): Promise<void> };
  const oldGeneration = internals.parkGeneration.get(id)!;
  h.control.secondLimit = true;
  await h.children.tell(id, 'continue', 'manager', undefined, false, { model: 'quota-test-2/child' });
  await until(() => h.children.history.records.get(id)?.parked?.provider === 'quota-test-2' && !h.children.live(id), 'second outage');
  const before = structuredClone(h.children.history.records.get(id));
  await internals.retryPark(id, new Error('stale retry'), oldGeneration);
  assert.deepEqual(h.children.history.records.get(id), before);
});

test('retarget rejects an active worker without changing its route', async t => {
  const h = await rig(t, {}, () => 'ok');
  let release!: () => void;
  h.control.hold = new Promise<void>(resolve => { release = resolve; });
  try {
    const [id] = await h.children.spawn([{ task: 'active' }], h.dir);
    await until(() => h.routes.length === 1, 'request active');
    await assert.rejects(() => h.children.tell(id, 'continue', 'manager', undefined, false, { model: 'quota-test-2/child' }), /active/);
    assert.equal(h.children.history.records.get(id)?.model, 'quota-test/child');
    assert.deepEqual(h.routes, ['quota-test']);
    release();
    await until(() => h.children.history.records.get(id)?.state === 'completed', 'completed');
  } finally { release(); }
});

test('deleting a parked worker while retarget opens prevents its continuation', async t => {
  const h = await rig(t, {}, () => 'limit');
  const [id] = await h.children.spawn([{ task: 'delete during retarget' }], h.dir);
  await until(() => !!h.children.history.records.get(id)?.parked && !h.children.live(id), 'parked');
  let release!: () => void;
  h.control.wait = new Promise<void>(resolve => { release = resolve; });
  const attempt = h.children.tell(id, 'continue', 'manager', undefined, false, { model: 'quota-test-2/child' });
  const rejected = assert.rejects(attempt, /worker or route changed/);
  const removal = h.children.remove(id);
  release();
  await rejected;
  await removal;
  assert.equal(h.children.history.records.has(id), false);
  assert.deepEqual(h.routes, ['quota-test']);
});

test('retarget revalidates a provider removed while its session is opening', async t => {
  const h = await rig(t, {}, () => 'limit');
  const [id] = await h.children.spawn([{ task: 'removed provider' }], h.dir);
  await until(() => !!h.children.history.records.get(id)?.parked && !h.children.live(id), 'parked');
  const before = structuredClone(h.children.history.records.get(id));
  let release!: () => void;
  h.control.wait = new Promise<void>(resolve => { release = resolve; });
  const attempt = h.children.tell(id, 'continue', 'manager', undefined, false, { model: 'quota-test-2/child' });
  const rejected = assert.rejects(attempt, /route changed/);
  try { h.runtime.unregisterProvider('quota-test-2'); } finally { release(); }
  await rejected;
  assert.deepEqual(h.children.history.records.get(id), before);
  assert.deepEqual(h.routes, ['quota-test']);
  assert.ok(h.clock.pending > 0);
});

test('failed retarget after the quota timer fires leaves the old route recoverable', async t => {
  const h = await rig(t, {}, () => 'limit');
  const [id] = await h.children.spawn([{ task: 'failure' }], h.dir);
  await until(() => !!h.children.history.records.get(id)?.parked && !h.children.live(id), 'parked');
  const before = structuredClone(h.children.history.records.get(id));
  let release!: () => void;
  h.control.wait = new Promise<void>(resolve => { release = resolve; });
  h.control.fail = true;
  const attempt = h.children.tell(id, 'continue', 'manager', undefined, false, { model: 'quota-test-2/child' });
  const rejected = assert.rejects(attempt, /synthetic session failure/);
  try {
    await h.clock.advance(62 * MIN);
    assert.equal(h.routes.length, 1, 'the old timer cannot start while retarget is reserved');
  } finally { release(); }
  await rejected;
  assert.deepEqual(h.children.history.records.get(id), before);
  assert.ok(h.clock.pending > 0, 'old wake is restored');
  h.control.fail = false; h.control.wait = undefined;
  await h.children.tell(id, 'continue', 'manager', undefined, false, { model: 'quota-test-2/child' });
  await until(() => h.children.history.records.get(id)?.state === 'completed', 'retry completed');
  assert.equal(h.routes.filter(route => route === 'quota-test-2').length, 1);
});

test('a worker that already used a tool and then hits the limit resumes with its conversation', async t => {
  let limited = false;
  const h = await rig(t, {}, (task, call) => task === 'tooly' && call === 2 && !limited ? (limited = true, 'limit') : limited ? 'limit' : 'ok');
  const [id] = await h.children.spawn([{ task: 'tooly' }], h.dir);
  await until(() => !!h.children.history.records.get(id)?.parked, 'parked after the tool call');
  assert.deepEqual(failures(h.reports), []);
  limited = false;
  await h.clock.advance(62 * MIN);
  await until(() => h.children.history.records.get(id)?.state === 'completed', 'completed after the reset');
  const last = h.seen.at(-1)!;
  assert.ok(last.some(line => line.startsWith('toolResult')), `the resumed request still holds the earlier tool result: ${JSON.stringify(last)}`);
  assert.ok(last.at(-1)!.startsWith('user:Your model account was out of quota'), `and ends with the resume note: ${last.at(-1)}`);
  assert.ok(h.reports.some(text => text.startsWith(`[${id}]`) && text.includes('Finished tooly')));
});

test('a spawn on an account known to be out of quota is queued until the reset, then starts under the same id', async t => {
  const block = { until: START + 30 * MIN };
  const h = await rig(t, block, () => 'ok');
  const answer = await h.children.start([{ task: 'later' }], h.dir);
  assert.match(answer, /Queued until 16:3\d/, answer);
  const [id] = [...h.children.history.records.keys()];
  assert.ok(answer.includes(id));
  assert.equal(h.calls.size, 0, 'no model request before the reset');
  assert.equal(h.children.history.records.get(id)?.parked?.queued, true);
  await assert.rejects(() => h.children.tell(id, 'hello'), /queued until/);
  await h.clock.advance(20 * MIN);
  assert.equal(h.calls.size, 0);
  await h.clock.advance(12 * MIN);
  await until(() => h.children.history.records.get(id)?.state === 'completed', 'started and completed');
  assert.equal(h.calls.get('later'), 1);
  assert.ok(h.reports.some(text => text.startsWith(`[${id}]`) && text.includes('Finished later')));
  assert.equal(h.children.history.records.get(id)?.parked, undefined);
});

test('a worker whose account stays out of quota is reported as failed only after the park limit', async t => {
  const h = await rig(t, {}, () => 'limit');
  const [id] = await h.children.spawn([{ task: 'stubborn' }], h.dir);
  for (let i = 0; i < 12 && !failures(h.reports).length; i++) {
    await until(() => !!h.children.history.records.get(id)?.parked || failures(h.reports).length > 0, `park ${i}`);
    await h.clock.advance(250 * MIN);
  }
  assert.equal(failures(h.reports).length, 1, 'finally one failure report');
  assert.match(failures(h.reports)[0], /429/);
  assert.equal(h.children.history.records.get(id)?.state, 'failed');
});

test('a parked worker is stopped without running again', async t => {
  const h = await rig(t, {}, () => 'limit');
  const [id] = await h.children.spawn([{ task: 'dropme' }], h.dir);
  await until(() => !!h.children.history.records.get(id)?.parked, 'parked');
  await h.children.stop(id);
  assert.equal(h.children.history.records.get(id)?.state, 'stopped');
  assert.equal(h.clock.pending <= 1, true, 'only the outage note timer may be left');
  const before = h.calls.get('dropme');
  await h.clock.advance(300 * MIN);
  assert.equal(h.calls.get('dropme'), before);
});

test('quotaError tells quota and rate limits from real failures and reads the reset hints', () => {
  const now = START;
  assert.deepEqual(quotaError('Task error: 429 rate_limit_error', now), {});
  assert.deepEqual(quotaError('You have hit your usage limit. Try again in ~1129 min.', now), { retryAt: now + 1129 * MIN });
  assert.deepEqual(quotaError('429 Too Many Requests, retry-after: 30', now), { retryAt: now + 30_000 });
  assert.deepEqual(quotaError('Your credit balance is too low to access the API', now), {});
  assert.deepEqual(quotaError('RESOURCE_EXHAUSTED: quota exceeded; resets at 2025-11-10T22:20:00Z', now), { retryAt: Date.UTC(2025, 10, 10, 22, 20) });
  assert.equal(quotaError('Task error: 400 invalid_request_error: messages.1: tool_use ids must be unique', now), undefined);
  assert.equal(quotaError('connection reset by peer', now), undefined);
  assert.equal(quotaError(undefined, now), undefined);
});

test('parkUntil waits for the latest known reset plus a margin, else backs off', () => {
  assert.equal(parkUntil(START, 0, START + 30 * MIN, START + 10 * MIN), START + 31 * MIN);
  assert.equal(parkUntil(START, 0, START - MIN, undefined), START + 5 * MIN, 'a reset in the past says nothing');
  assert.equal(parkUntil(START, 3), START + 60 * MIN);
  assert.equal(parkUntil(START, 99), START + 240 * MIN, 'backoff is capped');
  assert.equal(untilText(START + 31 * MIN, START), '16:31');
  assert.equal(untilText(START + 24 * 60 * MIN, START), '11/11 16:00');
});

test('while every manager model is out of quota, items are held, one notice is given, and one release carries them all', async () => {
  const clock = fakeClock();
  let returns: number | undefined = START + 90 * MIN;
  const notices: string[] = [], sent: string[][] = [];
  const outage = new QuotaOutage<string>({ now: clock.now, until: () => returns, notice: text => notices.push(text), send: items => sent.push(items),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.equal(outage.offer('report 1'), true);
  assert.equal(outage.offer('report 2'), true);
  await clock.advance(MIN);
  assert.equal(outage.offer('report 3'), true);
  assert.deepEqual(sent, [], 'no turn while out');
  assert.deepEqual(notices, ['cota esgotada em todas as contas; volto às 17:30 (Brasília)'], 'one notice for the outage');
  await clock.advance(80 * MIN);
  assert.deepEqual(sent, [], 'still out of quota');
  returns = undefined;
  await clock.advance(10 * MIN);
  assert.deepEqual(sent, [['report 1', 'report 2', 'report 3']], 'one release, in order');
  assert.equal(notices.length, 1);
  assert.equal(outage.offer('report 4'), false, 'back to normal: items go straight through');
  returns = START + 400 * MIN;
  assert.equal(outage.offer('report 5'), true);
  assert.equal(notices.length, 2, 'a new outage gets its own notice');
  outage.close();
  assert.equal(clock.pending, 0);
});

/** The host of the manager: a route is out while its own hint (learned from a failed turn on that provider) is in the future. */
const hintsOnly = (routes: string[]) => (learned: Readonly<Record<string, number>>) => {
  const ends = routes.map(provider => learned[provider]);
  return ends.every(at => at !== undefined) ? Math.min(...ends as number[]) : undefined;
};

test('an outage learned only from a failed turn holds items until the retry hint passes', async () => {
  const clock = fakeClock();
  const notices: string[] = [], sent: string[][] = [];
  const outage = new QuotaOutage<string>({ now: clock.now, until: hintsOnly(['main']), notice: text => notices.push(text), send: items => sent.push(items),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.equal(outage.offer('early'), false);
  outage.note('Agent error: You have hit your usage limit. Try again in ~1129 min.', 'main');
  assert.equal(outage.offer('report'), true);
  assert.equal(notices[0], 'cota esgotada em todas as contas; volto às 11/11 10:49 (Brasília)', 'the hint is 1129 min from 16:00, so tomorrow');
  await clock.advance(1100 * MIN);
  assert.deepEqual(sent, []);
  await clock.advance(40 * MIN);
  assert.deepEqual(sent, [['report']]);
});

test('a retry hint from another provider does not hold items while the manager\'s own account has quota', async () => {
  const clock = fakeClock();
  const notices: string[] = [], sent: string[][] = [];
  let cached: number | undefined = START + 30 * MIN; // The cache says the manager's account (main) is out for 30 min.
  const until = (learned: Readonly<Record<string, number>>) => {
    const ends = [cached, learned.main].filter((at): at is number => at !== undefined && at > clock.now());
    return ends.length ? Math.max(...ends) : undefined;
  };
  const outage = new QuotaOutage<string>({ now: clock.now, until, notice: text => notices.push(text), send: items => sent.push(items), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.equal(outage.offer('report'), true, 'the manager\'s account is out');
  // The failover tried another account, which answered with a 16-hour limit: it says nothing about the manager's account.
  outage.note('You have hit your ChatGPT usage limit (team plan). Try again in ~998 min.', 'other');
  cached = undefined;
  await clock.advance(40 * MIN);
  assert.deepEqual(sent, [['report']], 'released when the manager\'s own account returns');
  assert.equal(outage.offer('next'), false, 'and new items go straight through');
  outage.note('You have hit your usage limit. Try again in ~60 min.', 'main');
  assert.equal(outage.offer('after its own hint'), true, 'a hint from the manager\'s own account still holds');
});

test('switching the manager to a model with quota releases what was held for the old one, without waiting for its timer', async () => {
  const clock = fakeClock();
  const sent: string[][] = [];
  let returns: number | undefined = START + 10 * MIN; // The main model's account: out for 10 minutes.
  const outage = new QuotaOutage<string>({ now: clock.now, until: () => returns, notice: () => {}, send: items => sent.push(items), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.equal(outage.offer('report'), true);
  returns = START + 600 * MIN; // The failover moved the main model to an account that is out for hours.
  await clock.advance(11 * MIN);
  assert.deepEqual(sent, [], 'the first timer found the new main model still out and re-armed for the later time');
  outage.recheck();
  assert.deepEqual(sent, [], 'a model switch that leaves everything out holds on');
  returns = undefined; // The operator switches to an account that has quota.
  outage.recheck();
  assert.deepEqual(sent, [['report']], 'released at once');
  assert.equal(clock.pending, 0, 'and the old timer is gone');
  outage.recheck();
  assert.equal(sent.length, 1, 'nothing held, nothing to do');
});

test('a parked worker survives a reload: the next profile re-arms it and it resumes at its time', async t => {
  let limited = true;
  const h = await rig(t, {}, () => limited ? 'limit' : 'ok');
  const [id] = await h.children.spawn([{ task: 'persist' }], h.dir);
  await until(() => !!h.children.history.records.get(id)?.parked, 'parked');
  await h.children.close();
  const later = fakeClock(); await later.advance(10 * MIN);
  const reopened = h.build(later);
  assert.equal(reopened.history.records.get(id)?.state, 'interrupted');
  assert.ok(reopened.history.records.get(id)?.parked, 'the park is in the saved record');
  assert.equal(later.pending, 0, 'nothing runs before the profile asks');
  reopened.resumeParked();
  assert.equal(later.pending, 1);
  limited = false;
  await later.advance(80 * MIN);
  await until(() => reopened.history.records.get(id)?.state === 'completed', 'completed in the new profile');
  assert.ok(h.reports.some(text => text.startsWith(`[${id}]`) && text.includes('Finished persist')));
  assert.deepEqual(failures(h.reports), []);
});
