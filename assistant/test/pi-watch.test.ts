import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piDown, PiWatch } from '../src/pi-watch.ts';

const at = (hhmm: string) => `2026-11-15T${hhmm}:00.000Z`;
const launch = (t: string) => JSON.stringify({ timestamp: at(t), event: 'launch', pid: 1 });
const result = (t: string, exitCode: number | null, signal: string | null = null) => JSON.stringify({ timestamp: at(t), event: 'launcher_result', pid: 1, exitCode, signal });
const clock = (t: string) => Date.parse(at(t));
const GRACE = 10 * 60_000;

test('a Pi whose launcher ended with an error and was not reopened for the grace period is down', () => {

  const log = [launch('03:00'), result('08:48', 1)];
  assert.deepEqual(piDown(log, clock('08:55'), GRACE), null, 'inside the grace the launcher may still reopen it');
  assert.deepEqual(piDown(log, clock('09:00'), GRACE), { since: Date.parse(at('08:48')), exitCode: 1, signal: null });
});

test('a normal quit, a reopened Pi and an empty log are not an outage', () => {
  assert.equal(piDown([launch('03:00'), result('08:48', 0)], clock('20:00'), GRACE), null, 'exit 0 is the operator closing it');
  assert.equal(piDown([result('08:48', 1), launch('09:00')], clock('20:00'), GRACE), null, 'a later launch means it is back');
  assert.equal(piDown([], clock('20:00'), GRACE), null);
  assert.equal(piDown(['not json', ''], clock('20:00'), GRACE), null);
});

test('a fatal signal counts as an outage even without an exit code', () => {
  assert.deepEqual(piDown([result('08:48', null, 'SIGKILL')], clock('09:30'), GRACE), { since: Date.parse(at('08:48')), exitCode: null, signal: 'SIGKILL' });
});

test('the watch tells the operator once per outage and again after a recovery and a new outage', async () => {
  const sent: string[] = [];
  let lines = [launch('03:00'), result('08:48', 1)];
  let now = clock('09:00');
  const watch = new PiWatch({ read: () => lines, send: async text => { sent.push(text); }, now: () => now, graceMs: GRACE });
  await watch.check();
  await watch.check();
  assert.equal(sent.length, 1, 'the second pass is silent');
  assert.match(sent[0]!, /Pi/);
  assert.match(sent[0]!, /05:48/, 'the outage start in Brasília time');
  lines = [...lines, launch('09:05')];
  await watch.check();
  lines = [...lines, result('10:00', 1)];
  now = clock('10:30');
  await watch.check();
  assert.equal(sent.length, 2, 'a new outage is a new message');
});

test('a failed send is retried on the next pass', async () => {
  let fail = true; let calls = 0;
  const watch = new PiWatch({ read: () => [result('08:48', 1)], send: async () => { calls++; if (fail) throw new Error('slack down'); }, now: () => clock('09:30'), graceMs: GRACE });
  await assert.rejects(watch.check(), /slack down/);
  fail = false;
  await watch.check();
  await watch.check();
  assert.equal(calls, 2);
});
