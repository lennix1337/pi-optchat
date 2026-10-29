import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TaskStore } from '../src/store/db.ts';
import { createNotificationCenter, type DeliveredNotification } from '../src/notifications/center.ts';
import { TaskNotifier, windowsToast } from '../src/notifications/task-notifier.ts';
import { queuedTask, storeEvent } from './task-fixtures.ts';
import { withDir } from './runtime-support.ts';

const PROFILE = 'p';
const operator = {};
let ids = 0;
function event(store: TaskStore, taskId: string) {
  const n = ++ids;
  return storeEvent(PROFILE, taskId, store.nextSequence(), { eventId: `e${n}`, sourceEventId: `s${n}`, correlationId: `c${n}`, actorId: 'a', sourceKind: 'external', reference: `r${n}` });
}
function suggest(store: TaskStore, taskId: string, title: string) {
  const ev = event(store, taskId);
  return store.create({ ...queuedTask(PROFILE, taskId, title, ev.source.sourceEventId), status: 'suggested' }, ev);
}
function open(dir: string) {
  const store = new TaskStore(join(dir, 'tasks.sqlite'), PROFILE);
  const center = createNotificationCenter({ databasePath: join(dir, 'notifications.sqlite'), operatorAuthority: operator });
  center.setConsent('local', true, operator);
  const sent: DeliveredNotification[] = [];
  const notifier = new TaskNotifier({ store, center, channel: 'local', transport: note => { sent.push(note); } });
  return { store, center, sent, notifier, close() { center.close(); store.close(); } };
}

test('a new suggested task and a task needing input each push one fixed-text notice; titles never leave', () => withDir('notifier-', async dir => {
  const h = open(dir);
  try {
    await h.notifier.poll();
    suggest(h.store, 'slack-1', 'Segredo: senha do banco 1234');
    await h.notifier.poll();
    assert.deepEqual(h.sent, [{ id: 'slack-1:r1', text: 'A new task was suggested to the assistant.', ref: 'slack-1' }]);
    h.store.transition('slack-1', 1, 'queued', event(h.store, 'slack-1'));
    h.store.transition('slack-1', 2, 'working', event(h.store, 'slack-1'));
    h.store.transition('slack-1', 3, 'needs_input', event(h.store, 'slack-1'));
    await h.notifier.poll();
    await h.notifier.poll();
    assert.deepEqual(h.sent.map(n => n.id), ['slack-1:r1', 'slack-1:r4'], 'queued/working are silent; a repeated poll pushes nothing');
    assert.equal(h.sent[1].text, 'An assistant task needs your input.');
    assert.ok(h.sent.every(n => !n.text.includes('1234')));
  } finally { h.close(); }
}));

test('history before the first start is not pushed, and a restart does not push again', () => withDir('notifier-restart-', async dir => {
  let h = open(dir);
  try { suggest(h.store, 'old', 'old'); await h.notifier.poll(); assert.deepEqual(h.sent, [], 'first start begins at the end of history'); suggest(h.store, 'new', 'new'); await h.notifier.poll(); }
  finally { h.close(); }
  assert.deepEqual(h.sent.map(n => n.ref), ['new']);
  h = open(dir);
  try { await h.notifier.poll(); assert.deepEqual(h.sent, [], 'restart resumes after the stored cursor'); }
  finally { h.close(); }
}));

test('a notice recorded before a crash is not duplicated when its event is replayed', () => withDir('notifier-crash-', async dir => {
  let h = open(dir);
  try { await h.notifier.poll(); suggest(h.store, 't', 't'); await h.notifier.poll(); h.center.setCursor('tasks:local', 0); }
  finally { h.close(); }
  h = open(dir);
  try { await h.notifier.poll(); assert.deepEqual(h.sent, [], 'same id is a no-op and an accepted notice is not pushed twice'); }
  finally { h.close(); }
}));

test('the Windows toast passes only the fixed text, through the environment, and a failed toast rejects', async () => {
  const calls: { file: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  await windowsToast((file, args, env) => { calls.push({ file, args, env }); return Promise.resolve(0); })({ id: 'x:r1', text: 'An assistant task finished.', ref: 'x' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.OPTCHAT_TOAST_TEXT, 'An assistant task finished.');
  assert.ok(!calls[0].args.join(' ').includes('finished'), 'text is not on the command line');
  await assert.rejects(windowsToast(() => Promise.resolve(1))({ id: 'x:r1', text: 't', ref: 'x' }), /toast_failed/);
});
