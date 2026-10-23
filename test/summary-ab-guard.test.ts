import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function refuses(profile: string | undefined, expected: RegExp) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|API_KEY|OPTCHAT_AB_PROFILE/.test(name)));
  if (profile !== undefined) env.OPTCHAT_AB_PROFILE = profile;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'test/summary-ab-benchmark.ts'], {
    cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, expected);
}

test('summary experiment requires an explicitly selected profile before reading history', () => {
  refuses(undefined, /Set OPTCHAT_AB_PROFILE explicitly/);
});

test('summary experiment refuses provider calls before loading an explicit profile', () => {
  refuses('nonexistent-benchmark-profile', /Provider calls require --allow-provider-calls/);
});
