import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from './support.ts';
import { readProfileEffectPolicy } from '../src/effect-policy.ts';

test('shared policy preserves contract precedence over trusted adapter effects', () => withTempDir('policy-', dir => {
  writeFileSync(join(dir, 'autonomy.json'), JSON.stringify({ version: 1, default: 'advisor', rules: [
    { action: 'push', scope: ['owner/*'], level: 'free' },
    { action: 'publish', scope: ['owner/*'], level: 'report' },
    { action: 'deploy', scope: ['owner/*'], level: 'ask' },
  ] }));
  assert.equal(readProfileEffectPolicy(dir, () => [{ action: 'push', targets: ['owner/repo'] }])?.level, 'free');
  assert.equal(readProfileEffectPolicy(dir, () => [{ action: 'publish', targets: ['owner/repo'] }])?.level, 'report');
  assert.equal(readProfileEffectPolicy(dir, () => [
    { action: 'push', targets: ['owner/repo'] }, { action: 'deploy', targets: ['owner/repo'] },
  ])?.level, 'ask');
  assert.equal(readProfileEffectPolicy(dir, () => [{ action: 'push', targets: ['other/repo'] }])?.level, 'advisor');
  assert.equal(readProfileEffectPolicy(dir, () => [])?.level, 'advisor');
}));

test('missing policy does not fabricate approval; failures ask without private diagnostics', () => withTempDir('policy-', dir => {
  const unavailable = () => { throw new Error('PRIVATE-CANARY'); };
  assert.equal(readProfileEffectPolicy(undefined, unavailable), undefined);
  // No contract file: effects are still judged, and a failure to read them asks instead of fabricating approval.
  const noContract = readProfileEffectPolicy(dir, unavailable);
  assert.equal(noContract?.level, 'ask');
  assert.equal(JSON.stringify(noContract).includes('PRIVATE-CANARY'), false);
  assert.equal(readProfileEffectPolicy(dir, () => [{ action: 'deploy', targets: ['x'] }])?.level, 'ask', 'irreversible: the operator decides');
  assert.equal(readProfileEffectPolicy(dir, () => [{ action: 'push', targets: ['x'] }])?.level, 'advisor', 'the rest is as before');
  writeFileSync(join(dir, 'autonomy.json'), 'PRIVATE-CANARY');
  const invalid = readProfileEffectPolicy(dir, unavailable);
  assert.equal(invalid?.level, 'ask');
  assert.equal(JSON.stringify(invalid).includes('PRIVATE-CANARY'), false);
  writeFileSync(join(dir, 'autonomy.json'), JSON.stringify({ version: 1, default: 'free', rules: [] }));
  const failedMapping = readProfileEffectPolicy(dir, unavailable);
  assert.equal(failedMapping?.level, 'ask');
  assert.equal(JSON.stringify(failedMapping).includes('PRIVATE-CANARY'), false);
}));
