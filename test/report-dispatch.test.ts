import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReportDispatcher } from '../src/report-dispatch.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// external: Pi 1.5 can refuse a second send while an idle send is starting asynchronously.
const fakePi = ({ startMs = 10, startWaitMs = 60, startsTurn = () => true }: { startMs?: number; startWaitMs?: number; startsTurn?: (text: string) => boolean } = {}) => {
  const pi = { running: false, starting: false, delivered: [] as string[], lost: [] as string[], sends: [] as string[],
    send(text: string, fromIdle: boolean) {
      pi.sends.push(text);
      if (!fromIdle) { pi.delivered.push(text); return; }
      if (pi.starting || !startsTurn(text)) { pi.lost.push(text); return; }
      pi.starting = true;
      setTimeout(() => { pi.starting = false; pi.running = true; pi.delivered.push(text); dispatcher.started(); }, startMs).unref();
    } };
  const failures: [string, number, boolean][] = [];
  const dispatcher: ReportDispatcher<string> = new ReportDispatcher<string>({ idle: () => !pi.running, send: pi.send, pollMs: 1,
    startWaitMs, failed: (text, attempt, giveUp) => { failures.push([text, attempt, giveUp]); } });
  return { pi, dispatcher, failures };
};

test('several reports pushed at once while idle all reach Pi: one starts the turn, the rest queue into it', async () => {
  const { pi, dispatcher } = fakePi({ startWaitMs: 60_000 });
  const texts = Array.from({ length: 32 }, (_, i) => `report ${i}`);
  for (const text of texts) dispatcher.push(text);
  for (const t0 = Date.now(); Date.now() - t0 < 90;);
  const end = Date.now() + 5_000;
  while (pi.delivered.length < texts.length && Date.now() < end) await sleep(5);
  assert.deepEqual(pi.lost, []);
  assert.deepEqual(pi.delivered, texts);
});

test('a report sent while a turn runs is delivered at once', async () => {
  const { pi, dispatcher } = fakePi();
  pi.running = true;
  dispatcher.push('now');
  assert.deepEqual(pi.delivered, ['now']);
});

test('a turn started by someone else lets the waiting reports through without waiting for the deadline', async () => {
  const { pi, dispatcher } = fakePi({ startMs: 5_000 });
  dispatcher.push('first'); dispatcher.push('second');
  assert.deepEqual(pi.sends, ['first']);
  pi.running = true;
  await sleep(20);
  assert.deepEqual(pi.sends, ['first', 'second']);
  assert.deepEqual(pi.delivered, ['second']);
  dispatcher.close();
});

test('a send that never starts a turn is retried, then reported once and left to the journal', async () => {
  const { pi, dispatcher, failures } = fakePi({ startsTurn: text => text !== 'broken' });
  dispatcher.push('broken'); dispatcher.push('fine');
  await sleep(450);
  assert.deepEqual(failures, [['broken', 1, false], ['broken', 2, false], ['broken', 3, true]]);
  assert.deepEqual(pi.sends.filter(t => t === 'broken'), ['broken', 'broken', 'broken'], 'no fourth attempt');
  assert.deepEqual(pi.delivered, ['fine'], 'the report behind the broken one is not lost');
});

test('a lost first start is retried and delivered', async () => {
  let attempts = 0;
  const { pi, dispatcher, failures } = fakePi({ startsTurn: () => ++attempts > 1 });
  dispatcher.push('once');
  await sleep(200);
  assert.deepEqual(failures, [['once', 1, false]]);
  assert.deepEqual(pi.delivered, ['once']);
});

test('closing drops what waits and stops polling', async () => {
  const { pi, dispatcher } = fakePi({ startMs: 5_000 });
  dispatcher.push('a'); dispatcher.push('b');
  dispatcher.close();
  dispatcher.push('c');
  await sleep(30);
  assert.deepEqual(pi.sends, ['a']);
});
