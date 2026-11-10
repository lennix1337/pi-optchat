import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WakeWorkers, WORKER_DELIVERY_MS, WORKER_WAIT_MS } from '../src/wake-workers.ts';

test('only the original successful call and actual launch establish ownership', () => {
  const w = new WakeWorkers(() => 0);
  w.launched('foreign', ['x']); w.result('foreign', ['x']);
  w.called('call'); w.launched('call', ['a']); w.result('call', ['b']);
  assert.equal(w.holding, false);
  w.result('call', ['a'], true); assert.equal(w.holding, false);
  w.result('call', ['a']); assert.equal(w.holding, true);
});

test('duplicate delivery does not extend a missing report deadline', () => {
  let now = 0; const w = new WakeWorkers(() => now);
  w.called('c'); w.launched('c', ['a']); w.result('c', ['a']); w.queued('report', ['a']);
  now = WORKER_DELIVERY_MS - 1; w.queued('report', ['a']);
  now = WORKER_DELIVERY_MS; assert.equal(w.expire(), 'recover');
  assert.equal(w.notVerified, true);
  now += WORKER_DELIVERY_MS; assert.equal(w.expire(), 'finish');
  assert.equal(w.holding, false);
});

test('report before successful result still requires observation, reply and non-aborted settlement', () => {
  const w = new WakeWorkers(() => 0);
  w.called('c'); w.launched('c', ['a']); w.queued('report', ['a']); w.result('c', ['a']);
  w.replied(); w.settled(false); assert.equal(w.holding, true);
  w.observed('report'); w.replied(); w.settled(true); assert.equal(w.holding, true);
  w.settled(false); assert.equal(w.holding, true, 'aborted processing cannot count as a later reply');
  w.replied(); w.settled(false); assert.equal(w.holding, true, 'an independent reply cannot process the aborted report');
  w.observed('report'); w.replied(); w.settled(false); assert.equal(w.holding, false);
});

test('reobserving an aborted report does not renew its delivery deadline', () => {
  let now = 0; const w = new WakeWorkers(() => now);
  w.called('c'); w.launched('c', ['a']); w.result('c', ['a']); w.queued('report', ['a']);
  now = 10; w.observed('report'); w.settled(true);
  now = WORKER_DELIVERY_MS - 1; w.observed('report'); w.settled(true);
  now = WORKER_DELIVERY_MS; assert.equal(w.expire(), 'recover');
});

test('observed report is not treated as lost during a long processing turn', () => {
  let now = 0; const w = new WakeWorkers(() => now);
  w.called('c'); w.launched('c', ['a']); w.result('c', ['a']); w.queued('report', ['a']);
  now = WORKER_DELIVERY_MS - 1; w.observed('report');
  now = WORKER_DELIVERY_MS + 1;
  assert.equal(w.expire(), undefined); assert.equal(w.holding, true);
  now += 2 * WORKER_WAIT_MS;
  assert.equal(w.expire(), undefined);
  w.replied(); w.settled(false); assert.equal(w.holding, false);
});
