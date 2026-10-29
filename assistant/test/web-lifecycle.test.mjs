import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordinatedReconcile, coordinatedWrite, PanelLifecycle } from '../web/src/state.js';

function storage() {
  const data = new Map();
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k), data };
}

test('confirmed write stays confirmed when history fails', async () => {
  const life = new PanelLifecycle('p', storage());
  const result = await life.write({ requestId: 'r', action: 'create' }, async () => ({ taskId: 't' }), async () => { throw Error('offline'); });
  assert.equal(result.task.taskId, 't'); assert.ok(result.historyError); assert.equal(life.marker, null);
});

test('uncertain marker is persisted before dispatch and only matching journal clears it after reload', async () => {
  const store = storage(); const life = new PanelLifecycle('p', store);
  await assert.rejects(life.write({ requestId: 'r', taskId: 't', action: 'respond' }, async () => {
    assert.match([...store.data.values()][0], /"requestId":"r"/); throw Error('timeout');
  }, async () => {}));
  const restored = new PanelLifecycle('p', store);
  assert.equal(restored.reconcile([{ event: { profileId: 'p', taskId: 'other', source: { sourceEventId: 'r' } } }]), false);
  assert.equal(restored.reconcile([{ event: { profileId: 'p', taskId: 't', source: { sourceEventId: 'r' } } }]), true);
  assert.equal(store.data.size, 0);
});

test('storage failure prevents dispatch and pending writes cannot be replayed; stale conflict clears marker', async () => {
  let sent = 0;
  const broken = new PanelLifecycle('p', { getItem: () => null, setItem: () => { throw Error('storage'); } });
  await assert.rejects(broken.write({ requestId: 'r', action: 'create' }, async () => { sent++; }, async () => {}), /storage/);
  assert.equal(sent, 0);
  const life = new PanelLifecycle('p', storage());
  await assert.rejects(life.write({ requestId: 'r', action: 'create' }, async () => { throw Error('timeout'); }, async () => {}));
  await assert.rejects(life.write({ requestId: 's', action: 'create' }, async () => { sent++; }, async () => {}), /pending/);
  assert.equal(sent, 0);
  life.reconcile([{ event: { profileId: 'p', taskId: 't', source: { sourceEventId: 'r' } } }]);
  await assert.rejects(life.write({ requestId: 's', action: 'respond', taskId: 't' }, async () => { throw Object.assign(Error('stale'), { status: 409 }); }, async () => {}), /stale/);
  assert.equal(life.marker, null);
});

test('an already-open second panel observes another panel’s uncertain marker before sending', async () => {
  const store = storage();
  const first = new PanelLifecycle('p', store); const second = new PanelLifecycle('p', store);
  await assert.rejects(first.write({ requestId: 'first', action: 'create' }, async () => { throw Error('lost response'); }, async () => {}));
  let sent = false;
  await assert.rejects(second.write({ requestId: 'second', action: 'create' }, async () => { sent = true; return {}; }, async () => {}), /pending mutation/);
  assert.equal(sent, false);
});

test('a stale tab never removes a newer marker and observes another tab’s reconciliation', async () => {
  const store = storage(); const first = new PanelLifecycle('p', store);
  const lost = async () => { throw Error('lost'); };
  await assert.rejects(first.write({ requestId: 'A', action: 'create' }, lost, async () => {}));
  const stale = new PanelLifecycle('p', store);
  const entryA = { event: { profileId: 'p', taskId: 'ta', source: { sourceEventId: 'A' } } };
  assert.equal(first.reconcile([entryA]), true);
  await assert.rejects(first.write({ requestId: 'B', action: 'create' }, lost, async () => {}));
  assert.equal(stale.reconcile([entryA]), false);
  assert.equal(JSON.parse(store.getItem(first.key)).requestId, 'B');
  first.reconcile([{ event: { profileId: 'p', taskId: 'tb', source: { sourceEventId: 'B' } } }]);
  stale.reconcile([]); assert.equal(stale.marker, null);
});

test('proven pre-mutation HTTP refusals clear a marker, but 500 and transport failures do not', async () => {
  for (const status of [400, 401, 403, 404, 409, 500, undefined]) {
    const life = new PanelLifecycle('p', storage());
    await assert.rejects(life.write({ requestId: 'r', action: 'create' }, async () => { throw Object.assign(Error('refused'), { status }); }, async () => {}));
    assert.equal(Boolean(life.marker), status === 500 || status === undefined, String(status));
  }
});

test('cross-tab lock admission rejects unavailable or held locks before dispatch', async () => {
  const life = new PanelLifecycle('p', storage()); let sent = 0;
  const send = async () => { sent++; return { taskId: 't' }; };
  const marker = { requestId: 'r', action: 'create' };
  await assert.rejects(coordinatedWrite(life, undefined, marker, send, async () => {}), /coordination unavailable/);
  const busy = { request: async (name, options, callback) => { assert.equal(name, life.key); assert.equal(options.ifAvailable, true); return callback(null); } };
  await assert.rejects(coordinatedWrite(life, busy, marker, send, async () => {}), /panel busy/);
  assert.equal(sent, 0);
  assert.equal(life.storage.data.size, 0);
  const admitted = { request: async (name, options, callback) => callback({ name }) };
  const result = await coordinatedWrite(life, admitted, marker, send, async () => {});
  assert.equal(result.task.taskId, 't'); assert.equal(sent, 1);
});

test('reconciliation uses the same profile lock and cannot remove a replacement identity', async () => {
  const store = storage(); const life = new PanelLifecycle('p', store);
  await assert.rejects(life.write({ requestId: 'A', action: 'create' }, async () => { throw Error('lost'); }, async () => {}));
  const entry = { event: { profileId: 'p', taskId: 't', source: { sourceEventId: 'A' } } };
  const busy = { request: async (name, options, callback) => { assert.equal(name, life.key); assert.equal(options.ifAvailable, true); return callback(null); } };
  assert.equal(await coordinatedReconcile(life, busy, [entry]), false);
  assert.equal(JSON.parse(store.getItem(life.key)).requestId, 'A');
  const expected = life.marker;
  store.setItem(life.key, JSON.stringify({ requestId: 'B', action: 'create' }));
  assert.equal(life.clearMarker(expected), false);
  assert.equal(JSON.parse(store.getItem(life.key)).requestId, 'B');
  const free = { request: async (name, options, callback) => callback({ name }) };
  assert.equal(await coordinatedReconcile(life, free, [entry]), false);
  assert.equal(JSON.parse(store.getItem(life.key)).requestId, 'B');
});

test('a stale draft keeps its text and revisions until explicitly rebound to the reviewed task', () => {
  const life = new PanelLifecycle('p', storage());
  const original = { taskId: 't', revision: 2, inputRevision: 3 };
  const current = { taskId: 't', revision: 4, inputRevision: 5 };
  life.saveDraft(original, 'private response');
  life.saveDraft(current, 'edited response');
  assert.deepEqual(life.draft(current), { revision: 2, inputRevision: 3, text: 'edited response' });
  life.rebaseDraft(current);
  assert.deepEqual(life.draft(current), { revision: 4, inputRevision: 5, text: 'edited response' });
  assert.equal(life.storage.data.size, 0);
});

test('paging progress survives polls and drafts retain their original decision', () => {
  const life = new PanelLifecycle('p', storage());
  life.pollPage('page2'); life.nextPage('page3'); life.pollPage('page2');
  assert.equal(life.cursor, 'page3'); life.nextPage(null); life.pollPage('page2'); assert.equal(life.cursor, null);
  const task = { taskId: 't', revision: 2, inputRevision: 3 };
  life.saveDraft(task, 'private response');
  assert.deepEqual(life.draft({ ...task, revision: 4, inputRevision: 5 }), { revision: 2, inputRevision: 3, text: 'private response' });
  assert.equal([...life.storage.data.values()].join(''), '');
});
