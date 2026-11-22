import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezeGreen, type Exec } from '../src/merge-ci-guard.ts';

const checks = (conclusion: string) => ({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion }], mergeStateStatus: 'CLEAN', state: 'OPEN' });
const gh = (value: unknown, code = 0): Exec => async () => ({ code, stdout: JSON.stringify(value), stderr: code ? 'no pull requests found' : '' });

test('green pushes are frozen; red, missing and unreadable PRs pass', async () => {
  assert.match((await freezeGreen('git push origin feature', '/repo', gh(checks('SUCCESS')))).reason!, /passed.*new PR/i);
  for (const mergeStateStatus of ['DIRTY', 'BEHIND']) {
    assert.equal((await freezeGreen('git push origin feature', '/repo', gh({ ...checks('SUCCESS'), mergeStateStatus }))).reason, undefined, mergeStateStatus);
  }
  assert.equal((await freezeGreen('git push origin feature', '/repo', gh(checks('FAILURE')))).reason, undefined);
  assert.equal((await freezeGreen('git push origin feature', '/repo', gh({ state: 'OPEN', statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }] }))).reason, undefined);
  assert.match((await freezeGreen('git push -u origin HEAD:refs/heads/feature', '/repo', gh(checks('SUCCESS')))).reason!, /passed/i);
  assert.equal((await freezeGreen('git push origin feature', '/repo', gh({}, 1))).reason, undefined);
  const error: Exec = async () => { throw new Error('gh unavailable'); };
  const unavailable = await freezeGreen('git push origin feature', '/repo', error);
  assert.equal(unavailable.reason, undefined);
  assert.match(unavailable.note!, /could not read/i);
  assert.match((await freezeGreen('node scripts/ship.mjs -m test --all', '/repo', gh(checks('SUCCESS')))).reason!, /passed/i);
});
