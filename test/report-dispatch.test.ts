import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReportDispatcher } from '../src/report-dispatch.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Pi as 1.5 behaves: a send from idle starts a turn after a delay and a second send made meanwhile is refused and lost. */
const fakePi = ({ startMs = 10, startsTurn = () => true }: { startMs?: number; startsTurn?: (text: string) => boolean } = {}) => {
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
    startWaitMs: 60, failed: (text, attempt, giveUp) => { failures.push([text, attempt, giveUp]); } });
  return { pi, dispatcher, failures };
};

test('several reports pushed at once while idle all reach Pi: one starts the turn, the rest queue into it', async () => {
  const { pi, dispatcher } = fakePi();
  const texts = Array.from({ length: 32 }, (_, i) => `report ${i}`);
  for (const text of texts) dispatcher.push(text);
  await sleep(100);
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
  pi.running = true; // the operator typed a message: a turn is running now
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
