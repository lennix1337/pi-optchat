import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createNotificationCenter, type DeliveredNotification } from '../src/notifications/center.ts';
import { withDir } from './runtime-support.ts';

const operator = {};
// 2026-10-28T12:00:00Z is 09:00 in São Paulo (UTC-3, no DST in 2026).
const NOON_UTC = Date.UTC(2026, 9, 28, 12, 0);
const LATE_UTC = Date.UTC(2026, 9, 29, 2, 0); // 23:00 local

function center(dir: string, now: () => number = () => NOON_UTC, boundary?: (name: string, id: string) => void) {
  return createNotificationCenter({ databasePath: join(dir, 'notifications.sqlite'), operatorAuthority: operator, now, boundary });
}
function collector() {
  const sent: DeliveredNotification[] = [];
  return { sent, transport: (note: DeliveredNotification) => { sent.push(note); } };
}

test('nothing is pushed to a channel without operator consent; it stays visible as suppressed', () => withDir('notify-consent-', async dir => {
  const c = center(dir);
  try {
    c.notify({ id: 'task-1:needs_input', channel: 'local', category: 'task_needs_input', ref: 'task-1' });
    const { sent, transport } = collector();
    assert.deepEqual(await c.deliver('local', transport), { accepted: 0, deferred: 0, suppressed: 1, failed: 0 });
    assert.deepEqual(sent, []);
    assert.equal(c.list()[0].state, 'suppressed');
    assert.equal(c.list()[0].reason, 'no_consent');
    assert.throws(() => c.setConsent('local', true, {}), /unauthorized/);
    c.setConsent('local', true, operator);
    c.notify({ id: 'task-2:needs_input', channel: 'local', category: 'task_needs_input', ref: 'task-2' });
    assert.deepEqual(await c.deliver('local', transport), { accepted: 1, deferred: 0, suppressed: 0, failed: 0 });
    assert.deepEqual(sent.map(n => n.id), ['task-2:needs_input'], 'consent does not resurrect suppressed notifications');
    c.setConsent('local', false, operator);
    c.notify({ id: 'task-3:finished', channel: 'local', category: 'task_finished', ref: 'task-3' });
    await c.deliver('local', transport);
    assert.equal(sent.length, 1, 'revoked consent stops further pushes');
  } finally { c.close(); }
}));

test('quiet hours defer delivery across midnight in the configured time zone, then deliver once', () => withDir('notify-quiet-', async dir => {
  let now = LATE_UTC;
  const c = center(dir, () => now);
  try {
    c.setConsent('web', true, operator);
    assert.throws(() => c.setQuietHours({ start: '22:00', end: '07:00', timeZone: 'America/Sao_Paulo' }, {}), /unauthorized/);
    assert.throws(() => c.setQuietHours({ start: '25:00', end: '07:00', timeZone: 'America/Sao_Paulo' }, operator), /invalid_quiet_hours/);
    assert.throws(() => c.setQuietHours({ start: '22:00', end: '07:00', timeZone: 'Mars/Base' }, operator), /invalid_quiet_hours/);
    c.setQuietHours({ start: '22:00', end: '07:00', timeZone: 'America/Sao_Paulo' }, operator);
    c.notify({ id: 'approval-9', channel: 'web', category: 'approval_pending', ref: 'review-9' });
    const { sent, transport } = collector();
    assert.deepEqual(await c.deliver('web', transport), { accepted: 0, deferred: 1, suppressed: 0, failed: 0 });
    assert.equal(c.list()[0].state, 'pending');
    now = Date.UTC(2026, 9, 29, 9, 59); // 06:59 local, still quiet
    assert.equal((await c.deliver('web', transport)).deferred, 1);
    now = Date.UTC(2026, 9, 29, 10, 0); // 07:00 local
    assert.equal((await c.deliver('web', transport)).accepted, 1);
    assert.equal((await c.deliver('web', transport)).accepted, 0, 'accepted notifications are not pushed again');
    assert.equal(sent.length, 1);
    c.setQuietHours(null, operator);
  } finally { c.close(); }
}));

test('stable ids deduplicate; conflicting reuse refuses; free text and unknown categories are rejected', () => withDir('notify-dedup-', async dir => {
  const c = center(dir);
  try {
    c.setConsent('local', true, operator);
    const note = { id: 'task-1:finished', channel: 'local', category: 'task_finished', ref: 'task-1' } as const;
    c.notify(note); c.notify({ ...note });
    assert.equal(c.list().length, 1);
    assert.throws(() => c.notify({ ...note, ref: 'task-2' }), /notification_conflict/);
    assert.throws(() => c.notify({ ...note, id: 'x', body: 'Your password: hunter2' } as never), /invalid_notification/);
    assert.throws(() => c.notify({ ...note, id: 'y', category: 'free_text' } as never), /invalid_notification/);
    assert.throws(() => c.notify({ ...note, id: 'z', channel: 'sms' } as never), /invalid_notification/);
    const { sent, transport } = collector();
    await c.deliver('local', transport);
    c.notify(note);
    await c.deliver('local', transport);
    assert.equal(sent.length, 1, 're-notifying after acceptance does not deliver again');
  } finally { c.close(); }
}));

test('lock-screen content is fixed per category: no task title, secret or personal data reaches the transport', () => withDir('notify-minimize-', async dir => {
  const c = center(dir);
  try {
    c.setConsent('local', true, operator);
    c.notify({ id: 'n-1', channel: 'local', category: 'task_needs_input', ref: 'task-7' });
    const { sent, transport } = collector();
    await c.deliver('local', transport);
    assert.deepEqual(Object.keys(sent[0]).sort(), ['id', 'ref', 'text']);
    assert.equal(sent[0].text, 'An assistant task needs your input.');
    assert.equal(sent[0].ref, 'task-7');
    assert.throws(() => c.notify({ id: 'n-2', channel: 'local', category: 'task_finished', ref: 'card 4111 1111 1111 1111' }), /invalid_notification/, 'refs are opaque ids, not text');
  } finally { c.close(); }
}));

test('transport acceptance is not human reading; only markRead records a read, and failures stay visible', () => withDir('notify-read-', async dir => {
  const c = center(dir);
  try {
    c.setConsent('web', true, operator);
    c.notify({ id: 'n-1', channel: 'web', category: 'task_ready_for_review', ref: 'task-1' });
    c.notify({ id: 'n-2', channel: 'web', category: 'effect_uncertain', ref: 'job-2' });
    assert.throws(() => c.markRead('n-1', 'web'), /not_delivered/, 'cannot read what was never delivered');
    let calls = 0;
    const result = await c.deliver('web', note => { calls++; if (note.id === 'n-2') throw new Error('socket closed: token=abc'); });
    assert.deepEqual(result, { accepted: 1, deferred: 0, suppressed: 0, failed: 1 });
    const accepted = c.list().find(n => n.id === 'n-1')!;
    assert.equal(accepted.state, 'accepted'); assert.equal(accepted.readAt, null); assert.equal(typeof accepted.acceptedAt, 'number');
    const failed = c.list().find(n => n.id === 'n-2')!;
    assert.equal(failed.state, 'pending'); assert.equal(failed.reason, 'delivery_failed'); assert.equal(failed.attempts, 1);
    assert.doesNotMatch(JSON.stringify(c.list()), /token=abc/);
    for (let i = 0; i < 3; i++) await c.deliver('web', note => { calls++; throw new Error(note.id); });
    assert.equal(c.list().find(n => n.id === 'n-2')!.state, 'failed');
    c.markRead('n-1', 'web');
    const read = c.list().find(n => n.id === 'n-1')!;
    assert.equal(read.state, 'read'); assert.equal(typeof read.readAt, 'number');
    c.markRead('n-1', 'web');
    assert.ok(calls >= 4);
  } finally { c.close(); }
}));

test('a crash between transport acceptance and recording resends the same id (at least once; channels deduplicate)', () => withDir('notify-crash-', async dir => {
  const c = center(dir, () => NOON_UTC, name => { if (name === 'transport_accepted') throw new Error('simulated crash'); });
  try {
    c.setConsent('local', true, operator);
    c.notify({ id: 'n-1', channel: 'local', category: 'task_finished', ref: 'task-1' });
    await assert.rejects(c.deliver('local', () => undefined), /simulated crash/);
  } finally { c.close(); }
  const reopened = center(dir);
  try {
    const seen: string[] = [];
    await reopened.deliver('local', note => { seen.push(note.id); });
    assert.deepEqual(seen, ['n-1']);
    assert.equal(reopened.list()[0].state, 'accepted');
  } finally { reopened.close(); }
}));
