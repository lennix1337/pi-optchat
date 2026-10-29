import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DisplayLearning, displayBinding } from '../src/memory/display-learning.ts';

test('decision apply and revert require exact binding and authority; stale applied values cannot be rolled back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'display-guards-'));
  const authority = {}; const learning = new DisplayLearning({ databasePath: join(dir, 'db'), profileId: 'p', operatorAuthority: authority });
  try {
    const first = displayBinding(learning.propose('dashboard status'));
    assert.equal(first.profileId, 'p');
    assert.throws(() => learning.measure({ ...first, profileId: 'other' }), /stale_binding/);
    learning.measure(first);
    assert.throws(() => learning.decide({ ...first, profileId: 'other' }, 'approve', authority, 'reason'), /stale_binding/);
    assert.throws(() => learning.decide(first, 'approve', {}, 'reason'), /unauthorized/);
    assert.throws(() => learning.decide({ ...first, baseHash: 'bad' }, 'approve', authority, 'reason'), /stale_binding/);
    assert.throws(() => learning.decide(first, 'bad' as 'approve', authority, 'reason'), /proposal_not_decidable/);
    learning.decide(first, 'approve', authority, 'reason');
    assert.throws(() => learning.apply(first, {}), /unauthorized/);
    assert.throws(() => learning.apply({ ...first, profileId: 'other' }, authority), /stale_binding/);
    assert.throws(() => learning.apply({ ...first, baseRevision: 42 }, authority), /stale_binding/);
    learning.apply(first, authority);
    assert.throws(() => learning.apply(first, authority), /proposal_not_approved/);
    assert.throws(() => learning.revert(first, {}, 'reason'), /unauthorized/);
    assert.throws(() => learning.revert({ ...first, profileId: 'other' }, authority, 'reason'), /stale_binding/);
    assert.throws(() => learning.revert({ ...first, candidateHash: 'bad' }, authority, 'reason'), /stale_binding/);
    assert.throws(() => learning.revert(first, authority, ''), /invalid_reason/);
    const second = displayBinding(learning.propose('dashboard status task in progress completed tasks'));
    learning.measure(second); learning.decide(second, 'approve', authority, 'reason'); learning.apply(second, authority);
    assert.throws(() => learning.revert(first, authority, 'reason'), /stale_applied/);
    learning.revert(second, authority, 'reason');
    assert.throws(() => learning.revert(first, authority, 'reason'), /stale_applied/);
    assert.throws(() => learning.revert(second, authority, 'reason'), /proposal_not_applied/);
  } finally { learning.close(); rmSync(dir, { recursive: true, force: true }); }
});
