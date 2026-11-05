import test from 'node:test';
import assert from 'node:assert/strict';
import { OpsError, startWithRetry } from '../src/ops/service.ts';

// At logon the PC is busy: the ACL and process inspections time out and the launcher's console closes, so one
// failed attempt used to leave the assistant down until someone started it by hand (05/11, reboot at 11:47).
const clock = () => {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
};

test('a logon start retries transient failures until the service runs', async () => {
  const c = clock();
  const codes = ['privacy_check_timed_out', 'process_inspection_failed', 'service_busy', 'start_unhealthy'];
  let calls = 0;
  const result = await startWithRetry(async () => {
    const code = codes[calls++];
    if (code) throw new OpsError(code);
    return { result: 'started' as const, pid: 7, endpoint: 'http://127.0.0.1:1' };
  }, { waitMs: 300_000, delayMs: 10_000, now: c.now, sleep: c.sleep });
  assert.equal(result.result, 'started');
  assert.equal(calls, 5);
});

test('a logon start gives up at once on a failure that waiting cannot fix', async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(startWithRetry(async () => { calls++; throw new OpsError('port_in_use'); }, { waitMs: 300_000, delayMs: 10_000, now: c.now, sleep: c.sleep }),
    (error: Error) => error.message === 'port_in_use');
  assert.equal(calls, 1);
});

test('a logon start stops retrying when the wait runs out and reports the last failure', async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(startWithRetry(async () => { calls++; throw new OpsError('privacy_check_timed_out'); }, { waitMs: 30_000, delayMs: 10_000, now: c.now, sleep: c.sleep }),
    (error: Error) => error.message === 'privacy_check_timed_out');
  assert.equal(calls, 4);
});
