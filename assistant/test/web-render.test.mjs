import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelState } from '../web/src/state.js';

test('unchanged polls preserve render revision and original channel after a response', () => {
  const state = new PanelState('p');
  const task = { taskId: 't', profileId: 'p', revision: 1, status: 'queued' };
  state.upsert(task);
  state.apply([{ task, event: { sequence: 1, profileId: 'p', channelId: 'Original subject' } }]);
  const revision = state.revision;
  state.upsert({ ...task });
  state.apply([{ task, event: { sequence: 1, profileId: 'p', channelId: 'Original subject' } }]);
  assert.equal(state.revision, revision);
  state.apply([{ task: { ...task, revision: 2, status: 'working' }, event: { sequence: 2, profileId: 'p', channelId: 'Browser action' } }]);
  assert.equal(state.revision, revision + 1);
  assert.equal(state.channels.get('t'), 'Original subject');
});
