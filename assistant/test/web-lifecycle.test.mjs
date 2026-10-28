import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelLifecycle } from '../web/src/state.js';

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

test('paging progress survives polls and drafts retain their original decision', () => {
  const life = new PanelLifecycle('p', storage());
  life.pollPage('page2'); life.nextPage('page3'); life.pollPage('page2');
  assert.equal(life.cursor, 'page3'); life.nextPage(null); life.pollPage('page2'); assert.equal(life.cursor, null);
  const task = { taskId: 't', revision: 2, inputRevision: 3 };
  life.saveDraft(task, 'private response');
  assert.deepEqual(life.draft({ ...task, revision: 4, inputRevision: 5 }), { revision: 2, inputRevision: 3, text: 'private response' });
  assert.equal([...life.storage.data.values()].join(''), '');
});
