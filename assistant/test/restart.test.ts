import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { producer, runWorker, withDir } from './runtime-support.ts';

test('a local task completes in a separate worker process with no TUI attached', () => withDir('runtime-local-', dir => {
  const front = producer(dir);
  front.enqueue('job-1', 'write', { name: 'out.txt', text: 'done offline' });
  front.close();
  runWorker(dir, 'worker-a');
  const view = producer(dir);
  try {
    const job = view.job('job-1')!;
    assert.equal(job.state, 'done');
    assert.deepEqual(job.result, { bytes: 12 });
    assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'done offline');
  } finally { view.close(); }
}));

for (const [boundary, attempts] of [['claimed', 2], ['handled', 2], ['recorded', 1]] as const) {
  test(`killing the worker at "${boundary}" and reopening finishes the idempotent job once`, () => withDir('runtime-restart-', dir => {
    const front = producer(dir);
    front.enqueue('job-1', 'write', { name: 'out.txt', text: 'v1' });
    assert.notEqual(runWorker(dir, 'worker-a', boundary), 0, 'the injected crash must kill the worker');
    const mid = front.job('job-1')!;
    assert.equal(mid.state, boundary === 'recorded' ? 'done' : 'running', 'state at the crash is what was durably committed');
    runWorker(dir, 'worker-b');
    try {
      const job = front.job('job-1')!;
      assert.equal(job.state, 'done');
      assert.equal(job.attempts, attempts);
      assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'v1');
    } finally { front.close(); }
  }));
}
