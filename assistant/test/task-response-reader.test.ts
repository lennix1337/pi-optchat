import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/store/db.ts';
import { queuedTask, storeEvent } from './task-fixtures.ts';

test('executor reads only the persisted response for this profile and exact input revision', () => {
  const store = new TaskStore(':memory:', 'reader');
  const task = queuedTask('reader', 'one', 'Draft a short note', 'create-one');
  const event = () => { const id = `event-${store.nextSequence()}`; return storeEvent('reader', task.taskId, store.nextSequence(), { eventId: id, correlationId: id, sourceEventId: store.nextSequence() === 1 ? 'create-one' : id, actorId: 'test', sourceKind: 'trusted-local-human', reference: 'test' }); };
  try {
    store.create(task, event());
    store.transition('one', 1, 'working', event());
    const waiting = store.transition('one', 2, 'needs_input', event());
    store.respond({ version: 1, profileId: 'reader', taskId: 'one', revision: waiting.revision, inputRevision: waiting.inputRevision, text: 'Use tomorrow at 10.' }, event());
    assert.equal(store.getResponse('one', waiting.inputRevision), 'Use tomorrow at 10.');
    assert.equal(store.getResponse('one', 1), null);
    assert.equal(store.getResponse('other', waiting.inputRevision), null);
    assert.throws(() => store.getResponse('one', 0), /Invalid/);
  } finally { store.close(); }
});
