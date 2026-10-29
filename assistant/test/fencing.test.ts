import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime as realCreateRuntime, type InternalHandler, type RuntimeOptions } from '../src/runtime/worker.ts';
import { withDir } from './runtime-support.ts';

type Create = typeof realCreateRuntime;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** A stale owner finishes after takeover; its write must not land. Returns the observed job. */
async function staleOwnerScenario(dir: string, createRuntime: Create) {
  let now = 1000;
  const gates = { a: deferred(), b: deferred() }; const started = { a: deferred(), b: deferred() };
  const handlers = (label: 'a' | 'b'): Record<string, InternalHandler> => ({
    task: async () => { started[label].release(); await gates[label].promise; return { by: label }; },
  });
  const base: Omit<RuntimeOptions, 'owner' | 'handlers'> = { databasePath: join(dir, 'runtime.db'), now: () => now, leaseMs: 100 };
  const a = createRuntime({ ...base, owner: 'a', handlers: handlers('a') });
  const b = createRuntime({ ...base, owner: 'b', handlers: handlers('b') });
  try {
    a.enqueue('job-1', 'task', {});
    assert.equal(await a.acquire(), true);
    assert.equal(await b.acquire(), false, 'a live lease is exclusive');
    const aRun = a.runOnce();
    await started.a.promise;
    now += 101;
    assert.equal(await b.acquire(), true, 'an expired lease can be taken over');
    assert.equal(b.job('job-1')!.state, 'queued', 'takeover recovers the in-flight idempotent job');
    const bRun = b.runOnce();
    await started.b.promise;
    // Both owners now hold the job as running; the stale one finishes first.
    gates.a.release();
    const staleError = await aRun.then(() => null, (error: Error) => error.message);
    gates.b.release(); await bRun;
    return { staleError, job: b.job('job-1')!, staleRunOnce: await a.runOnce().then(() => null, (error: Error) => error.message) };
  } finally { a.close(); b.close(); }
}

test('a stale owner cannot write after takeover', () => withDir('runtime-fence-', async dir => {
  const { staleError, job, staleRunOnce } = await staleOwnerScenario(dir, realCreateRuntime);
  assert.equal(staleError, 'lease_lost');
  assert.equal(staleRunOnce, 'lease_lost');
  assert.equal(job.state, 'done');
  assert.deepEqual(job.result, { by: 'b' }, 'the stale owner result must not overwrite the current owner');
}));

test('disposable mutant without the fencing check lets the stale owner overwrite the result', () => withDir('runtime-fence-mutant-', async dir => {
  const source = readFileSync(fileURLToPath(new URL('../src/runtime/worker.ts', import.meta.url)), 'utf8');
  const anchor = "lease.token !== this.token) throw new Error('lease_lost');";
  assert.equal(source.split(anchor).length, 2);
  // Copy the whole source tree so the mutant keeps every import the real worker has.
  cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'src', 'runtime', 'worker.ts'), source.replace(anchor, 'lease.token !== this.token) void 0;'));
  const mutant = await import(pathToFileURL(join(dir, 'src', 'runtime', 'worker.ts')).href) as { createRuntime: Create };
  const { job } = await staleOwnerScenario(join(dir, 'src'), mutant.createRuntime);
  assert.notDeepEqual(job.result, { by: 'b' }, 'the mutant must let the stale write land, proving the test detects it');
}));

test('clean stop refuses new work, children and effects, requeues the job and releases the lease', () => withDir('runtime-stop-', async dir => {
  const gate = deferred(); const started = deferred(); let childError = '';
  const runtime = createRuntimeFor(dir, 'a', {
    parent: async (_input, context) => {
      started.release(); await gate.promise;
      try { context.spawnChild('child-1', 'parent', {}); } catch (error) { childError = (error as Error).message; }
      if (context.signal.aborted) throw new Error('aborted');
    },
  });
  const other = createRuntimeFor(dir, 'b', { parent: () => undefined });
  try {
    runtime.enqueue('job-1', 'parent', {});
    assert.equal(await runtime.acquire(), true);
    const run = runtime.runOnce();
    await started.promise;
    const stopping = runtime.stop();
    gate.release();
    await stopping; await run;
    assert.equal(childError, 'worker_stopped');
    assert.deepEqual(runtime.jobs().map(job => job.id), ['job-1'], 'a stopped worker creates no child');
    assert.equal(runtime.job('job-1')!.state, 'queued', 'an interrupted job resumes later');
    assert.throws(() => runtime.enqueue('job-2', 'parent', {}), /worker_stopped/);
    await assert.rejects(runtime.runOnce(), /worker_stopped/);
    assert.equal(await other.acquire(), true, 'the lease is released at once on clean stop');
  } finally { runtime.close(); other.close(); }
}));

test('cancellation, backpressure, concurrency and idempotent enqueue', () => withDir('runtime-limits-', async dir => {
  let running = 0; let peak = 0; const seen: string[] = [];
  const gate = deferred(); const started = deferred();
  const runtime = createRuntimeFor(dir, 'a', {
    slow: async (input) => { running++; peak = Math.max(peak, running); seen.push((input as { n: number }).n.toString()); await new Promise(resolve => setTimeout(resolve, 20)); running--; },
    hold: async (_input, context) => { started.release(); await gate.promise; if (context.signal.aborted) throw new Error('aborted'); return 'finished'; },
  }, { maxConcurrent: 2, maxQueued: 4 });
  try {
    assert.equal(await runtime.acquire(), true);
    for (let n = 0; n < 4; n++) runtime.enqueue(`slow-${n}`, 'slow', { n });
    assert.throws(() => runtime.enqueue('slow-4', 'slow', { n: 4 }), /queue_full/);
    assert.equal(runtime.enqueue('slow-0', 'slow', { n: 0 }).id, 'slow-0', 'same id and input is idempotent');
    assert.throws(() => runtime.enqueue('slow-0', 'slow', { n: 9 }), /job_conflict/);
    assert.equal(runtime.cancel('slow-3'), 'cancelled');
    while (await runtime.runOnce());
    assert.equal(peak, 2);
    assert.deepEqual(seen.sort(), ['0', '1', '2']);
    assert.equal(runtime.job('slow-3')!.state, 'cancelled');

    runtime.enqueue('hold-1', 'hold', {});
    const run = runtime.runOnce();
    await started.promise;
    assert.equal(runtime.cancel('hold-1'), 'running');
    gate.release(); await run;
    assert.equal(runtime.job('hold-1')!.state, 'cancelled');
    assert.equal(runtime.job('hold-1')!.result, null);
  } finally { runtime.close(); }
}));

function createRuntimeFor(dir: string, owner: string, handlers: Record<string, InternalHandler>, extra: Partial<RuntimeOptions> = {}) {
  return realCreateRuntime({ databasePath: join(dir, 'runtime.db'), owner, handlers, ...extra });
}
