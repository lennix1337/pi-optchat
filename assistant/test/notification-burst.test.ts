import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createNotificationCenter, type DeliveredNotification } from '../src/notifications/center.ts';
import { withDir } from './runtime-support.ts';

const operator = {};
const START = Date.UTC(2026, 9, 28, 12, 0);

function setup(dir: string, clock: { now: number }) {
  const open = () => createNotificationCenter({ databasePath: join(dir, 'notifications.sqlite'), operatorAuthority: operator, now: () => clock.now });
  const sent: DeliveredNotification[] = [];
  return { open, sent, transport: (note: DeliveredNotification) => { sent.push(note); } };
}
const add = (c: ReturnType<typeof createNotificationCenter>, from: number, count: number, channel: 'local' | 'web' = 'local') => {
  for (let n = from; n < from + count; n++) c.notify({ id: `task-${n}:r2`, channel, category: 'task_ready_for_review', ref: `task-${n}` });
};

test('a burst of pending notices reaches the transport three times plus one summary', () => withDir('burst-pass-', async dir => {
  const clock = { now: START };
  const { open, sent, transport } = setup(dir, clock);
  const c = open();
  try {
    c.setConsent('local', true, operator);
    add(c, 0, 30);
    const result = await c.deliver('local', transport);
    assert.equal(sent.length, 4);
    assert.deepEqual(sent.slice(0, 3).map(n => n.text), Array(3).fill('An assistant task is ready for review.'));
    assert.equal(sent[3].text, 'Several assistant tasks changed; open the panel.');
    assert.deepEqual(result, { accepted: 4, deferred: 0, suppressed: 27, failed: 0 });
    const rows = c.list(500);
    const tasks = rows.filter(n => n.category === 'task_ready_for_review');
    assert.equal(tasks.filter(n => n.state === 'accepted').length, 3);
    const burst = tasks.filter(n => n.reason === 'burst');
    assert.equal(burst.length, 27);
    assert.ok(burst.every(n => n.state === 'suppressed' && n.attempts === 0), 'burst notices are recorded, never claimed for dispatch');
    assert.equal(tasks.filter(n => n.state === 'pending').length, 0);
    const summary = rows.filter(n => n.category === 'tasks_burst');
    assert.equal(summary.length, 1);
    assert.equal(summary[0].state, 'accepted');
  } finally { c.close(); }
}));

test('the cap holds across passes inside the window and resets after it', () => withDir('burst-window-', async dir => {
  const clock = { now: START };
  const { open, sent, transport } = setup(dir, clock);
  const c = open();
  try {
    c.setConsent('local', true, operator);
    add(c, 0, 30);
    await c.deliver('local', transport);
    assert.equal(sent.length, 4);

    clock.now = START + 30_000;
    add(c, 100, 10);
    assert.deepEqual(await c.deliver('local', transport), { accepted: 0, deferred: 0, suppressed: 10, failed: 0 });
    assert.equal(sent.length, 4, 'no more toasts, not even a second summary, while the window is spent');
    assert.equal(c.list(500).filter(n => /^task-1\d\d:/.test(n.id) && n.reason === 'burst').length, 10);

    clock.now = START + 61_000;
    add(c, 200, 1);
    assert.deepEqual(await c.deliver('local', transport), { accepted: 1, deferred: 0, suppressed: 0, failed: 0 });
    assert.equal(sent.length, 5);
    assert.equal(sent[4].text, 'An assistant task is ready for review.');
    assert.equal(c.list(500).find(n => n.id === 'task-200:r2')!.state, 'accepted');
  } finally { c.close(); }
}));

test('the window survives a restart and each channel has its own budget', () => withDir('burst-restart-', async dir => {
  const clock = { now: START };
  const { open, sent, transport } = setup(dir, clock);
  let c = open();
  try {
    c.setConsent('local', true, operator); c.setConsent('web', true, operator);
    add(c, 0, 3);
    await c.deliver('local', transport);
    assert.equal(sent.length, 3);
    c.close(); c = open();
    clock.now = START + 5_000;
    add(c, 10, 2);
    assert.deepEqual(await c.deliver('local', transport), { accepted: 1, deferred: 0, suppressed: 2, failed: 0 });
    assert.equal(sent.at(-1)!.text, 'Several assistant tasks changed; open the panel.');
    add(c, 20, 3, 'web');
    assert.deepEqual(await c.deliver('web', transport), { accepted: 3, deferred: 0, suppressed: 0, failed: 0 });
  } finally { c.close(); }
}));

test('a failed summary stays uncertain and is not replayed; consent and quiet hours still come first', () => withDir('burst-uncertain-', async dir => {
  const clock = { now: START };
  const { open, sent, transport } = setup(dir, clock);
  const c = open();
  try {
    add(c, 0, 6);
    assert.deepEqual(await c.deliver('local', transport), { accepted: 0, deferred: 0, suppressed: 6, failed: 0 });
    assert.ok(c.list().every(n => n.reason === 'no_consent'), 'without consent nothing is a burst and nothing is pushed');
    c.setConsent('local', true, operator);
    add(c, 10, 5);
    let calls = 0;
    const result = await c.deliver('local', note => { calls++; if (note.text.startsWith('Several')) throw new Error('toast_failed'); sent.push(note); });
    assert.deepEqual(result, { accepted: 3, deferred: 0, suppressed: 2, failed: 1 });
    const summary = c.list(500).find(n => n.category === 'tasks_burst')!;
    assert.equal(summary.state, 'uncertain'); assert.equal(summary.reason, 'transport_uncertain'); assert.equal(summary.attempts, 1);
    await c.deliver('local', transport);
    assert.equal(calls, 4); assert.equal(sent.length, 3);
    c.setQuietHours({ start: '08:00', end: '13:00', timeZone: 'UTC' }, operator);
    clock.now = START + 120_000;
    add(c, 30, 8);
    assert.deepEqual(await c.deliver('local', transport), { accepted: 0, deferred: 8, suppressed: 0, failed: 0 });
    assert.equal(c.list(500).filter(n => n.state === 'pending').length, 8, 'quiet hours keep notices pending, never burst-suppressed');
  } finally { c.close(); }
}));
