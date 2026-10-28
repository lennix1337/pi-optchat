import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelState } from '../web/src/state.js';

test('event resume is contiguous, deduplicated and cannot roll back a newer snapshot', () => {
  const state = new PanelState('p');
  const task = { taskId: 't', profileId: 'p', revision: 3, status: 'needs_input' };
  state.upsert(task);
  const entry = (sequence, revision) => ({ event: { sequence, profileId: 'p', taskId: 't', channelId: 'Pessoal', evidence: { reference: 'original' } }, task: { ...task, revision }, operation: 'transition' });
  state.apply([entry(1, 1), entry(2, 2)]); assert.equal(state.after, 2); assert.equal(state.tasks.get('t').revision, 3);
  state.apply([entry(2, 2)]); assert.equal(state.after, 2); assert.equal(state.events.length, 2);
  assert.throws(() => state.apply([entry(4, 4)]), /sequence/); assert.equal(state.after, 2);
  assert.throws(() => state.apply([{ ...entry(3, 3), event: { ...entry(3, 3).event, profileId: 'foreign' } }]), /profile/);
  assert.throws(() => state.upsert({ ...task, profileId: 'foreign' }), /profile/);
});

test('a rejected page is atomic, same-revision data does not replace a newer decision', () => {
  const state = new PanelState('p');
  state.upsert({ taskId: 't', profileId: 'p', revision: 4, status: 'working' });
  const entry = sequence => ({ event: { sequence, profileId: 'p', taskId: 't' }, task: { taskId: 't', profileId: 'p', revision: sequence, status: 'queued' } });
  assert.throws(() => state.apply([entry(1), entry(3)]), /sequence/);
  assert.equal(state.after, 0); assert.equal(state.events.length, 0);
  state.upsert({ taskId: 't', profileId: 'p', revision: 3, status: 'needs_input' });
  assert.equal(state.tasks.get('t').status, 'working');
});
