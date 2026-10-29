import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effect, lines, producer, runWorker, withDir } from './runtime-support.ts';

// Boundary → state committed at the crash → state after a fresh worker reopens.
const cases = [
  ['claimed', 'running', 'done'],
  ['before_dispatch', 'dispatching', 'done'],
  ['in_sink', 'dispatching', 'effect_uncertain'],
  ['after_dispatch', 'dispatching', 'done'],
  ['recorded', 'done', 'done'],
] as const;

for (const [boundary, atCrash, recovered] of cases) {
  test(`external effect killed at "${boundary}" is sent exactly once across restarts`, () => withDir('runtime-effect-', dir => {
    const front = producer(dir);
    try {
      front.enqueue('mail-1', 'effect', effect('op-1', 'hello'));
      assert.notEqual(runWorker(dir, 'worker-a', boundary), 0);
      assert.equal(front.job('mail-1')!.state, atCrash);
      runWorker(dir, 'worker-b');
      runWorker(dir, 'worker-c');
      assert.deepEqual(lines(dir, 'sink.log'), ['hello'], 'the external effect must never repeat');
      const job = front.job('mail-1')!;
      assert.equal(job.state, recovered);
      if (recovered === 'effect_uncertain') assert.equal(job.error, 'effect_uncertain');
    } finally { front.close(); }
  }));
}

test('an adapter reconciler can resolve an ambiguous effect by observation without resending', () => withDir('runtime-reconcile-', dir => {
  const front = producer(dir);
  try {
    front.enqueue('mail-1', 'effect', effect('op-1', 'hello'));
    runWorker(dir, 'worker-a', 'in_sink');
    runWorker(dir, 'worker-b', '', 'reconcile');
    const job = front.job('mail-1')!;
    assert.equal(job.state, 'done');
    assert.deepEqual(job.result, { reconciled: true });
    assert.deepEqual(lines(dir, 'sink.log'), ['hello']);
  } finally { front.close(); }
}));

test('an effect that needs review stays blocked and is never sent without a grant', () => withDir('runtime-blocked-', dir => {
  const front = producer(dir);
  try {
    front.enqueue('mail-1', 'effect', effect('op-1', 'hello'));
    runWorker(dir, 'worker-a', '', 'review');
    const job = front.job('mail-1')!;
    assert.equal(job.state, 'blocked');
    assert.equal(job.error, 'approval_required');
    assert.deepEqual(lines(dir, 'sink.log'), []);
  } finally { front.close(); }
}));

test('disposable mutant that bypasses the gateway repeats the effect and fails the no-repeat test', () => withDir('runtime-mutant-', dir => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const part of ['src', 'test']) cpSync(join(root, part), join(dir, part), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const worker = join(dir, 'src', 'runtime', 'worker.ts');
  const source = readFileSync(worker, 'utf8');
  const anchor = 'await gateway!.dispatch(this.effectRequest(input), async (bytes, metadata) => {';
  assert.equal(source.split(anchor).length, 2);
  writeFileSync(worker, source.replace(anchor, 'await (async (sink: (b: Uint8Array, m: any) => unknown) => sink(this.effectRequest(input).payload, input))(async (bytes, metadata) => {'));
  // Without NODE_TEST_CONTEXT the nested runner reports normally instead of deferring to this one.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-name-pattern=in_sink', join(dir, 'test', 'recovery.test.ts')], { encoding: 'utf8', env, timeout: 60_000, windowsHide: true });
  assert.notEqual(run.status, 0, 'the mutant must fail');
  assert.match(run.stdout, /the external effect must never repeat/);
}));
