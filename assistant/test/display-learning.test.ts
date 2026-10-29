import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DisplayLearning, displayBinding, readDisplayPreference } from '../src/memory/display-learning.ts';

function rig(run: (db: string, open: (profile: string, authority: object) => DisplayLearning, close: (instance: DisplayLearning) => void) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'display-learning-'));
  const db = join(dir, 'db.sqlite');
  const opened = new Set<DisplayLearning>();
  const open = (profile: string, authority: object) => { const instance = new DisplayLearning({ databasePath: db, profileId: profile, operatorAuthority: authority }); opened.add(instance); return instance; };
  const close = (instance: DisplayLearning) => { instance.close(); opened.delete(instance); };
  try { run(db, open, close); } finally { for (const instance of opened) instance.close(); rmSync(dir, { recursive: true, force: true }); }
}
const better = 'dashboard status: task in progress; completed tasks';
test('persistent measured review, apply and rollback show exact display value', () => rig((db, open, close) => {
  const authority = {}; let a = open('p', authority);
  const p = a.propose(better), b = displayBinding(p); const measured = a.measure(b);
  assert.equal(measured.state, 'measured'); assert.deepEqual([measured.measurement?.baseline.score, measured.measurement?.candidate.score], [1, 4]);
  assert.equal(measured.measurement?.candidate.results.length, 4);
  assert.equal(a.decide(b, 'approve', authority, 'reviewed').state, 'approved'); assert.equal(a.current().text, 'dashboard');
  assert.equal(a.apply(b, authority).state, 'applied'); assert.equal(readDisplayPreference(db, 'p').text, better);
  close(a); a = open('p', authority);
  assert.deepEqual(a.get(p.id, 1).measurement, measured.measurement); assert.equal(a.revert(b, authority, 'undo').state, 'reverted');
  assert.deepEqual(readDisplayPreference(db, 'p'), { text: 'dashboard', revision: 2, hash: b.baseHash });
  assert.throws(() => a.apply(b, authority), /proposal_not_approved/); assert.throws(() => a.revert(b, authority, 'again'), /proposal_not_applied/);
}));
test('guards reject forged, stale, replayed and non-improving changes', () => rig((_db, open) => {
  const authority = {}; const a = open('p', authority); const c = open('p', {});
  assert.throws(() => a.propose(''), /invalid_candidate/); assert.throws(() => a.propose('x\n'), /invalid_candidate/); assert.throws(() => a.propose('dashboard'), /proposal_no_change/);
  const no = a.propose('dashboard only'); const nb = displayBinding(no); assert.equal(a.measure(nb).state, 'rejected'); assert.throws(() => a.decide(nb, 'approve', authority, 'x'), /proposal_not_decidable/);
  const p = a.propose(better), b = displayBinding(p); assert.throws(() => a.measure({ ...b, datasetHash: 'wrong' }), /stale_binding/); assert.throws(() => a.measure({ ...b, candidateHash: 'wrong' }), /stale_binding/);
  a.measure(b); assert.throws(() => a.measure(b), /proposal_not_measurable/); assert.throws(() => a.decide(b, 'approve', {}, 'x'), /unauthorized/); assert.throws(() => a.apply(b, authority), /proposal_not_approved/); assert.throws(() => a.decide(b, 'approve', authority, ''), /invalid_reason/);
  const other = c.propose('dashboard status task in progress'); const ob = displayBinding(other); c.measure(ob); const otherAuthority = {}; // caller cannot manufacture c's authority
  assert.throws(() => c.decide(ob, 'approve', otherAuthority, 'x'), /unauthorized/);
  a.decide(b, 'approve', authority, 'ok'); assert.throws(() => a.decide(b, 'approve', authority, 'again'), /proposal_not_decidable/); a.apply(b, authority);
  assert.throws(() => c.decide(ob, 'approve', {}, 'x'), /unauthorized/);
  const staleAuthority = {}; const s = open('other', staleAuthority); assert.throws(() => s.get(p.id, 1), /proposal_not_found/);
}));
test('concurrent reviewed proposals and rollback are fenced by current revision', () => rig((_db, open) => {
  const aa = {}, bb = {}; const a = open('p', aa); const b = open('p', bb);
  const p = a.propose(better), q = b.propose('dashboard status task in progress'); const pb = displayBinding(p), qb = displayBinding(q);
  a.measure(pb); b.measure(qb); a.decide(pb, 'approve', aa, 'ok'); b.decide(qb, 'approve', bb, 'ok'); a.apply(pb, aa);
  assert.throws(() => b.apply(qb, bb), /stale_baseline/);
  const later = b.propose('dashboard status task in progress completed tasks extra'), lb = displayBinding(later);
  // Equal scoring candidates are not approved, so the earlier applied value remains authoritative.
  assert.equal(b.measure(lb).state, 'rejected'); assert.equal(a.revert(pb, aa, 'undo').state, 'reverted');
  assert.throws(() => b.apply(qb, bb), /stale_baseline/);
}));
