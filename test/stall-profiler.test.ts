import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createStallWatch } from '../src/loop-stalls.ts';
import { attributeStallCpu, createStallProfiler, startStallProfiler, type CpuProfileLike } from '../src/stall-profiler.ts';

const makeProfile = (overrides: Partial<CpuProfileLike> = {}): CpuProfileLike => ({
  startTime: 1_000_000,
  endTime: 2_000_000, // 1000 ms window
  nodes: [
    { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 3, 4, 5] },
    { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 }, children: [] },
    { id: 3, callFrame: { functionName: '(program)', url: '', lineNumber: -1 }, children: [] },
    { id: 4, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 }, children: [] },
    { id: 5, callFrame: { functionName: 'outerWork', url: 'file:///C:/app/src/worker.ts', lineNumber: 9 }, children: [6, 7] },
    { id: 6, callFrame: { functionName: 'hotLoop', url: 'file:///C:/app/src/worker.ts', lineNumber: 19 }, children: [] },
    { id: 7, callFrame: { functionName: '', url: '/app/src/helper.ts', lineNumber: 4 }, children: [] },
  ],
  samples: [2, 6, 6, 7, 4, 3, 2],
  // cumulative ms from startTime (window = [1000, 2000]):
  // idx 0 (idle): 100ms -> t=1100
  // idx 1 (hotLoop): 200ms -> t=1300
  // idx 2 (hotLoop): 250ms -> t=1550
  // idx 3 (anon): 100ms -> t=1650
  // idx 4 (gc): 50ms -> t=1700
  // idx 5 (program): 100ms -> t=1800
  // idx 6 (idle): 150ms -> t=1950
  timeDeltas: [100_000, 200_000, 250_000, 100_000, 50_000, 100_000, 150_000],
  ...overrides,
});

test('attributeStallCpu attributes samples inside the stall window, keeps GC/program, and drops idle', () => {
  const profile = makeProfile();
  // Window ends at 2000 ms => window is [1000, 2000]. Stall is [1200, 1980].
  // Inside [1200, 1980]: idx 1 (hotLoop 200ms), idx 2 (hotLoop 250ms), idx 3 (anon 100ms), idx 4 (gc 50ms), idx 5 (program 100ms), idx 6 (idle - dropped).
  const cpu = attributeStallCpu(profile, 2000, 1200, 1980);
  assert.ok(cpu);
  assert.equal(cpu.samples, 5);
  assert.equal(cpu.topSelf[0].frame, 'hotLoop (worker.ts:20)');
  assert.equal(cpu.topSelf[0].ms, 450);
  assert.ok(cpu.topSelf.some(f => f.frame === '(anonymous) (helper.ts:5)' && f.ms === 100));
  assert.ok(cpu.topSelf.some(f => f.frame === '(garbage collector)' && f.ms === 50));
  assert.ok(cpu.topSelf.some(f => f.frame === '(program)' && f.ms === 100));
  assert.ok(!cpu.topSelf.some(f => f.frame.includes('(idle)')));
  assert.deepEqual(cpu.topStacks[0], {
    stack: ['hotLoop (worker.ts:20)', 'outerWork (worker.ts:10)'],
    ms: 450,
  });
});

test('attributeStallCpu returns undefined when stall is outside the profile window or samples are empty', () => {
  const profile = makeProfile();
  assert.equal(attributeStallCpu(profile, 2000, 500, 900), undefined);
  assert.equal(attributeStallCpu(profile, 2000, 2100, 2500), undefined);
  assert.equal(attributeStallCpu(makeProfile({ samples: [], timeDeltas: [] }), 2000, 1200, 1800), undefined);
  assert.equal(attributeStallCpu(makeProfile({ samples: [2, 2], timeDeltas: [200_000, 200_000] }), 2000, 1000, 1900), undefined);
});

test('attributeStallCpu caps topSelf and topStacks at 5 and stack depth at 8', () => {
  const nodes = [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2] }];
  for (let id = 2; id <= 11; id++) {
    nodes.push({
      id,
      callFrame: { functionName: `fn${id}`, url: 'deep.ts', lineNumber: id - 1 },
      children: id < 11 ? [id + 1] : [],
    });
  }
  // 6 different leaf nodes so topSelf > 5 would be truncated to 5
  const samples = [11, 10, 9, 8, 7, 6];
  const timeDeltas = [60_000, 50_000, 40_000, 30_000, 20_000, 10_000];
  const cpu = attributeStallCpu({ startTime: 0, endTime: 500_000, nodes, samples, timeDeltas }, 500, 0, 500);
  assert.ok(cpu);
  assert.equal(cpu.topSelf.length, 5);
  assert.equal(cpu.topStacks.length, 5);
  assert.equal(cpu.topStacks[0].stack.length, 8);
  assert.equal(cpu.topStacks[0].stack[0], 'fn11 (deep.ts:11)');
});

function deliberateBusyWait(ms: number) {
  const end = performance.now() + ms;
  let acc = 0;
  while (performance.now() < end) {
    for (let i = 0; i < 200_000; i++) acc = (acc + (i ^ (i >>> 3))) | 0;
  }
  return acc;
}

test('integration: real profiler captures deliberateBusyWait on the CPU during a stall', async () => {
  let t = performance.now();
  const watch = createStallWatch(() => t);
  const profiler = createStallProfiler({ windowMs: 250, watch });
  await profiler.start();
  try {
    // Advance watchdog baseline, then block for ~400 ms with deliberateBusyWait
    t = performance.now();
    watch.tick();
    deliberateBusyWait(400);
    t = performance.now();
    watch.tick();

    // Wait for the rolling window to stop and attribute the stall
    await new Promise(resolve => setTimeout(resolve, 400));

    const stalls = watch.stalls();
    assert.equal(stalls.length, 1, `expected 1 stall, got ${stalls.length}`);
    const [stall] = stalls;
    assert.ok(stall.cpu, 'expected stall.cpu to be attached');
    assert.ok(stall.cpu.samples > 0, `expected samples > 0, got ${stall.cpu.samples}`);
    assert.ok(
      stall.cpu.topSelf[0].frame.includes('deliberateBusyWait'),
      `expected topSelf[0].frame to include deliberateBusyWait, got ${JSON.stringify(stall.cpu.topSelf)}`,
    );
  } finally {
    profiler.stop();
  }
});

test('startStallProfiler stays off unless PI_STALL_PROFILER=1 (its rolls stall the loop)', () => {
  const prev = process.env.PI_STALL_PROFILER;
  delete process.env.PI_STALL_PROFILER;
  assert.equal(startStallProfiler(), undefined);
  process.env.PI_STALL_PROFILER = '0';
  try {
    assert.equal(startStallProfiler(), undefined);
  } finally {
    if (prev === undefined) delete process.env.PI_STALL_PROFILER;
    else process.env.PI_STALL_PROFILER = prev;
  }
});

test('startStallProfiler stops a profiler an earlier module copy left running (survives Pi reload)', () => {
  const prev = process.env.PI_STALL_PROFILER;
  const slot = globalThis as Record<symbol, unknown>, key = Symbol.for('pi-optchat.stall-profiler');
  let stopped = 0;
  slot[key] = { start: async () => {}, roll: async () => {}, stop: () => { stopped++; } };
  delete process.env.PI_STALL_PROFILER;
  try {
    assert.equal(startStallProfiler(), undefined);
    assert.equal(stopped, 1);
    assert.equal(slot[key], undefined);
  } finally {
    delete slot[key];
    if (prev === undefined) delete process.env.PI_STALL_PROFILER;
    else process.env.PI_STALL_PROFILER = prev;
  }
});
