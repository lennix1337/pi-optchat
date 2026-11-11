import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packReports, BUNDLE_SEPARATOR, type Bundleable } from '../src/report-bundle.ts';
import { ReportDispatcher } from '../src/report-dispatch.ts';
import { alertReport, foldAlerts, shellReporter, type ShellJob } from '../src/shells.ts';
import type { ShellAlert } from '../src/shell-alerts.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface R extends Bundleable<R> { solo?: boolean }
const make = (members: R[], text: string, count: number): R => ({ text, count, members });
const pack = (waiting: R[], max?: number) => packReports(waiting, r => !!r.solo, make, max);

test('reports pack into one message with each header kept, and a lone report stays itself', () => {
  const a = { text: '[aaaaaaaa] one' }, b = { text: '[bbbbbbbb] two' }, c = { text: '[cccccccc] three' };
  const [bundle, ...rest] = pack([a, b, c]);
  assert.deepEqual(rest, []);
  assert.equal(bundle.text, [a.text, b.text, c.text].join(BUNDLE_SEPARATOR));
  assert.equal(bundle.count, 3);
  assert.deepEqual(bundle.members, [a, b, c]);
  assert.deepEqual(pack([a]), [a], 'one report is not wrapped');
});

test('a cap splits the pack in order, a solo report travels alone, and a bundle is opened before repacking', () => {
  const reports: R[] = Array.from({ length: 6 }, (_, i) => ({ text: `r${i}`.padEnd(10, '.') }));
  const split = pack(reports, 25);
  assert.deepEqual(split.map(m => (m.members ?? [m]).map(r => r.text.slice(0, 2))), [['r0', 'r1'], ['r2', 'r3'], ['r4', 'r5']]);
  assert.equal(pack([reports[0], { text: 'solo', solo: true }, reports[1]]).length, 3);
  assert.deepEqual(pack([split[0], reports[2]]).map(m => m.members?.length), [3], 'no bundle inside a bundle');
  const huge = { text: 'x'.repeat(100) };
  assert.deepEqual(pack([reports[0], huge, reports[1]], 25).map(m => m.text.length), [10, 100, 10], 'a report over the cap goes whole, alone');
});

/** Pi 1.5: a send from idle starts a turn after a delay; a second send made meanwhile is refused and lost. */
const fakePi = () => {
  const pi = { running: false, starting: false, delivered: [] as R[], lost: 0,
    send(report: R, fromIdle: boolean) {
      if (!fromIdle) { pi.delivered.push(report); return; }
      if (pi.starting) { pi.lost++; return; }
      pi.starting = true;
      setTimeout(() => { pi.starting = false; pi.running = true; pi.delivered.push(report); dispatcher.started(); }, 10).unref();
    } };
  const dispatcher: ReportDispatcher<R> = new ReportDispatcher<R>({ idle: () => !pi.running, send: pi.send, pollMs: 1, startWaitMs: 60,
    pack: waiting => pack(waiting, 120), gatherMs: 15, failed: () => undefined });
  return { pi, dispatcher };
};
const carried = (delivered: R[]) => delivered.flatMap(m => m.members ?? [m]).map(r => r.text);

test('30 reports pushed at once while idle leave in ceil(size/cap) messages, none lost, in order', async () => {
  const { pi, dispatcher } = fakePi();
  const texts = Array.from({ length: 30 }, (_, i) => `[r${String(i).padStart(2, '0')}] done`);
  dispatcher.pushAll(texts.map(text => ({ text })));
  await sleep(120);
  assert.equal(pi.lost, 0);
  assert.deepEqual(carried(pi.delivered), texts);
  const bundled = packReports(texts.map(text => ({ text })), () => false, make, 120).length;
  assert.equal(pi.delivered.length, bundled);
  assert.ok(pi.delivered.length < 30 / 3, `${pi.delivered.length} messages`);
});

test('one fresh report while idle goes out at once and alone', async () => {
  const { pi, dispatcher } = fakePi();
  dispatcher.pushAll([{ text: '[one] done' }]);
  await sleep(40);
  assert.deepEqual(pi.delivered.map(m => m.text), ['[one] done']);
  assert.equal(pi.delivered[0].members, undefined);
});

test('reports that arrive while a turn runs wait a moment and steer in as one message', async () => {
  const { pi, dispatcher } = fakePi();
  pi.running = true;
  for (const i of [1, 2, 3]) dispatcher.push({ text: `[w${i}] done` });
  assert.deepEqual(pi.delivered, [], 'held for company');
  await sleep(40);
  assert.equal(pi.delivered.length, 1);
  assert.deepEqual(carried(pi.delivered), ['[w1] done', '[w2] done', '[w3] done']);
});

const alert = (matches: number, line: number, text = 'ECONNREFUSED'): ShellAlert => ({ matches, firstLine: line, lastLine: line, total: line, hidden: 0, shown: [{ line, text, before: [] }] });
const job = (patch: Partial<ShellJob> = {}): ShellJob => ({ id: '5fe89754', alert: '[ioredis].*ECONNREFUSED', state: 'running', mode: 'background', command: 'node api.js', output: '', started: 0, notify: 'end', matches: 0, ...patch }) as ShellJob;
const timers = () => {
  const pending = new Map<number, { at: number; run: () => void }>();
  let now = 0, next = 0;
  return { now: () => now,
    setTimer: (run: () => void, ms: number) => { const id = next++; pending.set(id, { at: now + ms, run }); return () => { pending.delete(id); }; },
    advance(ms: number) { const to = now + ms; for (;;) { const due = [...pending].filter(([, t]) => t.at <= to).sort((x, y) => x[1].at - y[1].at)[0]; if (!due) break; pending.delete(due[0]); now = due[1].at; due[1].run(); } now = to; } };
};
const reporter = () => {
  const clock = timers(), sent: { text: string; once: boolean }[] = [];
  return { clock, sent, reporter: shellReporter({ live: () => true, main: async (text, once) => { sent.push({ text, once }); }, agent: async () => false, failed: () => undefined },
    { foldMs: 8_000, maxHoldMs: 60_000, now: clock.now, setTimer: clock.setTimer }) };
};

test('ten alerts of one shell inside the debounce are one message with the count and the latest lines', () => {
  const { clock, sent, reporter: r } = reporter();
  const j = job();
  for (let i = 1; i <= 10; i++) { r.alerted(j, '', alert(1, i * 10, `[ioredis] ECONNREFUSED ${i}`)); clock.advance(2_000); }
  assert.equal(sent.length, 0, 'still gathering while the shell keeps alerting');
  clock.advance(8_000);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^\[shell 5fe89754\] alert: .* · 10 new matches on lines 10–100 \(5 not shown\) · 100 so far/);
  assert.match(sent[0].text, /ECONNREFUSED 10/);
  assert.doesNotMatch(sent[0].text, /ECONNREFUSED 1\b/, 'only the latest lines are shown');
});

test('alerts of two shells are not mixed, and a steady stream is still sent once the longest wait is reached', () => {
  const { clock, sent, reporter: r } = reporter();
  r.alerted(job({ id: 'aaaaaaaa' }), '', alert(1, 1)); r.alerted(job({ id: 'bbbbbbbb' }), '', alert(1, 2));
  clock.advance(8_000);
  assert.deepEqual(sent.map(s => s.text.slice(0, 16)), ['[shell aaaaaaaa]', '[shell bbbbbbbb]']);
  sent.length = 0;
  for (let i = 0; i < 40; i++) { r.alerted(job(), '', alert(1, i)); clock.advance(5_000); }
  assert.ok(sent.length >= 3 && sent.length <= 4, `${sent.length} messages for 200 s of steady alerts`);
});

test('the end of a shell arriving before its folded alert is sent joins it', () => {
  const { clock, sent, reporter: r } = reporter();
  const j = job();
  r.alerted(j, '', alert(2, 5)); clock.advance(1_000); r.alerted(j, '', alert(1, 9));
  r.finished({ ...j, state: 'completed', exitCode: 1, matches: 3 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /3 new matches/);
  assert.match(sent[0].text, /\n\n\[shell 5fe89754\] /);
  assert.equal(sent[0].once, true);
  clock.advance(60_000);
  assert.equal(sent.length, 1, 'the folded alert is not sent a second time');
});

test('foldAlerts adds the counts and spans the lines; a lone alert reads as before', () => {
  const merged = foldAlerts([alert(2, 5), alert(3, 40)]);
  assert.equal(merged.matches, 5);
  assert.equal(merged.firstLine, 5);
  assert.equal(merged.lastLine, 40);
  const one = alert(1, 7);
  assert.equal(alertReport('x', 'p', foldAlerts([one])), alertReport('x', 'p', one));
});
