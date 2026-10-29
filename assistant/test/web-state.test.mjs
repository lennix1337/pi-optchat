import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelState, splitChannel, subjectLabel } from '../web/src/state.js';

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

test('the project suffix of a channel becomes the task project; the subject keeps the first channel name', () => {
  const state = new PanelState('p');
  const task = { taskId: 't', profileId: 'p', revision: 1, status: 'working' };
  const entry = (sequence, channelId) => ({ event: { sequence, profileId: 'p', taskId: 't', channelId, evidence: { reference: '-' } }, task: { ...task, revision: sequence }, operation: 'transition' });
  state.apply([entry(1, 'OptChat'), entry(2, 'OptChat')]);
  assert.equal(state.channels.get('t'), 'OptChat'); assert.equal(state.projects.get('t'), undefined);
  state.apply([entry(3, 'OptChat \u00b7 harness')]);
  assert.equal(state.channels.get('t'), 'OptChat'); assert.equal(state.projects.get('t'), 'harness');
  assert.deepEqual(splitChannel('Shell \u00b7 dentai'), ['Shell', 'dentai']);
  assert.deepEqual(splitChannel('Pessoal \u00b7 outro'), ['Pessoal \u00b7 outro', undefined]);
});

test('a listed task knows its subject and project from the page, before its events are loaded', () => {
  const state = new PanelState('p');
  state.upsert({ taskId: 't', profileId: 'p', revision: 9, status: 'ready_for_review' });
  state.seedChannels({ t: 'Pessoal', u: 'Wake \u00b7 harness', foreign: 42 });
  assert.equal(state.channels.get('t'), 'Pessoal'); assert.equal(state.projects.get('t'), undefined);
  assert.equal(state.channels.get('u'), 'Wake'); assert.equal(state.projects.get('u'), 'harness');
  assert.equal(state.channels.has('foreign'), false);
  state.seedChannels({ t: 'Outro' });
  assert.equal(state.channels.get('t'), 'Pessoal', 'the first channel stays the subject');
  state.seedChannels(undefined);
});

test('platform conversation ids read as names; other subjects are shown as written', () => {
  assert.equal(subjectLabel('slack:D0CDWE0T540'), 'Slack · mensagem direta');
  assert.equal(subjectLabel('slack:C0ABC123'), 'Slack · canal C0ABC123');
  assert.equal(subjectLabel('Slack #harness'), 'Slack #harness');
  assert.equal(subjectLabel('Pessoal'), 'Pessoal');
});
