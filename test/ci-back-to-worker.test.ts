import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciBackToWorker, RESUME_LIMIT, type SubscriberClaim } from '../src/ci-back-to-worker.ts';

const claim = (over: Partial<SubscriberClaim> = {}): SubscriberClaim => ({ subscriber: 'w1', repo: 'o/r', wake: true, text: '#7 checks failed: windows', accepted: false, accept() { this.accepted = true; }, ...over });
const setup = (state?: string, taken = true) => {
  const sent: string[] = [], manager: string[] = [];
  const handle = ciBackToWorker({ info: id => id === 'w1' && state ? { state } : undefined, notice: async (_id, text) => { sent.push(text); return taken; }, toManager: text => { manager.push(text); } });
  return { handle, sent, manager };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

test('red CI of a shipped PR resumes the worker that wrote it', async () => {
  const { handle, sent, manager } = setup('completed'), c = claim();
  handle(c); await settle();
  assert.equal(c.accepted, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /windows/);
  assert.match(sent[0], /Do not loosen a test/);
  assert.deepEqual(manager, []);
});

test('a notice for a worker this session does not know stays with the manager', () => {
  const { handle } = setup(undefined), c = claim();
  handle(c);
  assert.equal(c.accepted, false);
});

test('a connected or deleted worker is not resumed', () => {
  const connected = ciBackToWorker({ info: () => ({ state: 'completed', connected: true }), notice: async () => true, toManager: () => {} }), c = claim();
  connected(c);
  assert.equal(c.accepted, false);
  const { handle } = setup('deleted'), d = claim();
  handle(d);
  assert.equal(d.accepted, false);
});

test('a quiet notice is taken and dropped without waking the worker', async () => {
  const { handle, sent } = setup('completed'), c = claim({ wake: false });
  handle(c); await settle();
  assert.equal(c.accepted, true);
  assert.deepEqual(sent, []);
});

test('a worker that cannot take the notice hands it to the manager', async () => {
  const { handle, manager } = setup('completed', false);
  handle(claim()); await settle();
  assert.equal(manager.length, 1);
  assert.match(manager[0], /w1 could not take/);
});

test('after the resume limit the notice goes to the manager', async () => {
  const { handle, sent } = setup('completed');
  for (let i = 0; i < RESUME_LIMIT; i++) { handle(claim()); await settle(); }
  const last = claim(); handle(last);
  assert.equal(sent.length, RESUME_LIMIT);
  assert.equal(last.accepted, false);
});
