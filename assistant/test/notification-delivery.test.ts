import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createNotificationCenter } from '../src/notifications/center.ts';
import { withDir } from './runtime-support.ts';

const authority = {};
const note = { id: 'notice-1', channel: 'local', category: 'task_finished', ref: 'task-1' } as const;
const open = (dir: string, boundary?: (name: string) => void) => createNotificationCenter({ databasePath: join(dir, 'notices.sqlite'), operatorAuthority: authority, boundary });

test('bounded inspection returns only recent notices in chronological order', () => withDir('delivery-recent-', async dir => {
  const c = open(dir);
  try {
    for (let n = 0; n < 60; n++) c.notify({ ...note, id: `notice-${n}` });
    assert.deepEqual(c.list(3).map(n => n.id), ['notice-57', 'notice-58', 'notice-59']);
    assert.equal(c.list().length, 60);
    assert.throws(() => c.list(0), /invalid_options/);
  } finally { c.close(); }
}));

test('durable claim fences concurrent SQLite connections', () => withDir('delivery-race-', async dir => {
  const a = open(dir), b = open(dir);
  try {
    a.setConsent('local', true, authority); a.notify(note);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const first = a.deliver('local', async () => { calls++; await waiting; });
    assert.equal(b.list()[0].reason, 'dispatch_in_flight');
    await b.deliver('local', () => { calls++; });
    release(); await first;
    assert.equal(calls, 1);
    assert.equal(b.list()[0].state, 'accepted');
    assert.equal(b.list()[0].readAt, null);
  } finally { a.close(); b.close(); }
}));

test('claim and accepted boundaries survive restart without replay', () => withDir('delivery-crash-', async dir => {
  for (const boundary of ['dispatch_claimed', 'transport_accepted']) {
    const c = open(dir, name => { if (name === boundary) throw new Error('crash'); });
    c.setConsent('local', true, authority);
    c.notify({ ...note, id: boundary });
    let calls = 0;
    await assert.rejects(c.deliver('local', () => { calls++; }), /crash/);
    c.close();
    const reopened = open(dir);
    try {
      await reopened.deliver('local', () => { calls++; });
      const record = reopened.list().find(n => n.id === boundary)!;
      assert.equal(record.state, 'uncertain');
      assert.equal(record.reason, 'dispatch_in_flight');
      assert.equal(record.attempts, 1);
      assert.equal(calls, boundary === 'dispatch_claimed' ? 0 : 1);
    } finally { reopened.close(); }
  }
}));

test('transport rejection after effect is uncertain and never retried', () => withDir('delivery-failure-', async dir => {
  const c = open(dir);
  try {
    c.setConsent('local', true, authority); c.notify(note);
    let calls = 0;
    await c.deliver('local', () => { calls++; throw new Error('private secret'); });
    await c.deliver('local', () => { calls++; });
    assert.equal(calls, 1);
    assert.equal(c.list()[0].state, 'uncertain');
    assert.equal(c.list()[0].reason, 'transport_uncertain');
    assert.doesNotMatch(JSON.stringify(c.list()), /private secret/);
    assert.throws(() => c.markRead(note.id, 'local'), /not_delivered/);
  } finally { c.close(); }
}));
