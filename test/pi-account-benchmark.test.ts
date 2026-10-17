import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertCleanBaseline, assertContainerIsolation, assertSubscriptionAccount, createContainerExecTool, clipped,
  cleanupTaskResources, dockerRunArgs, inspectPiAccount, loadOpenHumanTask, BENCHMARK_MODEL, runWithTaskTimeout,
  stopTaskContainer, TaskContainerSetupError, validateStartedTaskContainer, SWE_TASK_TIMEOUT_MS, writeRunReceipt,
} from './pi-account-benchmark.ts';

const fixtureImage = 'swebench/sweb.eval.x86_64.django_1776_django-11099:latest';
const successfulCommand = { exitCode: 0, stdout: '', stderr: '', timedOut: false };

test('large command previews retain error and exit status without exceeding the output budget', async () => {
  assert.equal(clipped('small output'), 'small output');
  assert.equal(clipped('x'.repeat(16_000)).length, 16_000);
  const tool = createContainerExecTool('0123456789ab', async () => ({
    stdout: `HEADER\n${'x'.repeat(30_000)}`, stderr: 'AssertionError: expected empty path', exitCode: 1, timedOut: false,
  }));
  const result = await tool.execute('preview', { command: 'test command' }, undefined, undefined, {} as never);
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('');
  assert.ok(text.startsWith('HEADER'));
  assert.ok(text.includes('middle omitted'));
  assert.ok(text.includes('AssertionError: expected empty path'));
  assert.ok(text.endsWith('[exit code: 1]'));
  assert.equal(text.length, 16_000);
});

function mockRuntime(options: { credential?: 'oauth' | 'api_key'; registered?: boolean; oauth?: boolean; subscription?: boolean } = {}) {
  const calls: string[] = [];
  const runtime = {
    getModel(provider: string, id: string) { calls.push(`model:${provider}/${id}`); return options.registered === false ? undefined : { provider, id }; },
    async listCredentials() { calls.push('credentials'); return options.credential ? [{ providerId: BENCHMARK_MODEL.provider, type: options.credential }] : [{ providerId: BENCHMARK_MODEL.provider, type: 'oauth' as const }]; },
    isUsingOAuth(provider: string) { calls.push(`oauth:${provider}`); return options.oauth ?? true; },
    isUsingSubscription(provider: string) { calls.push(`subscription:${provider}`); return options.subscription ?? true; },
    stream() { throw new Error('Preflight must not request inference.'); },
  };
  return { runtime, calls };
}

test('preflight resolves the explicit Luna model and only inspects non-secret OAuth metadata', async () => {
  const { runtime, calls } = mockRuntime();
  const report = await inspectPiAccount(runtime as never, 'fixture-profile');
  assert.equal(report.provider, 'openai-codex-account-2');
  assert.equal(report.model, 'gpt-6-luna');
  assert.equal(report.modelRegistered, true);
  assert.equal(report.credentialType, 'oauth');
  assert.equal(report.usingOAuth, true);
  assert.equal(report.usingSubscription, true);
  assert.equal(report.eligible, true);
  assert.equal(report.requestedThinking, 'high');
  assert.equal(report.lastSelectedOptChatProfile, 'fixture-profile');
  assert.equal(report.inferencePerformed, false);
  assert.equal(JSON.stringify(report).includes('secret'), false);
  assert.deepEqual(calls, ['model:openai-codex-account-2/gpt-6-luna', 'credentials', 'oauth:openai-codex-account-2', 'subscription:openai-codex-account-2']);
});

test('API-key credentials and non-subscription auth fail closed', async () => {
  const apiKey = await inspectPiAccount(mockRuntime({ credential: 'api_key' }).runtime as never, null);
  assert.equal(apiKey.eligible, false);
  assert.throws(() => assertSubscriptionAccount(apiKey), /OAuth subscription credential/);

  const nonSubscription = await inspectPiAccount(mockRuntime({ subscription: false }).runtime as never, null);
  assert.equal(nonSubscription.eligible, false);
  assert.throws(() => assertSubscriptionAccount(nonSubscription), /OAuth subscription credential/);

  const missingModel = await inspectPiAccount(mockRuntime({ registered: false }).runtime as never, null);
  assert.equal(missingModel.eligible, false);
  assert.throws(() => assertSubscriptionAccount(missingModel), /not registered/);
});

test('clean baseline receipt parsing separates status from the commit', () => {
  assert.equal(assertCleanBaseline(successfulCommand, { ...successfulCommand, stdout: 'a1b2c3d4e5f6\n' }), 'a1b2c3d4e5f6');
  assert.throws(() => assertCleanBaseline({ ...successfulCommand, stdout: ' M src/changed.ts\n' }, { ...successfulCommand, stdout: 'a1b2c3d4e5f6\n' }), /did not start cleanly/);
  assert.throws(() => assertCleanBaseline(successfulCommand, { ...successfulCommand, stdout: 'not-a-commit\n' }), /did not start cleanly/);
});

test('timeout budget matches the OpenHuman SWE runbook 1200-second gate', () => {
  assert.equal(SWE_TASK_TIMEOUT_MS, 1200 * 1000);
});

test('task timeout aborts the active operation and returns a timeout outcome', async () => {
  let aborts = 0;
  let finish: (() => void) | undefined;
  const result = await runWithTaskTimeout(() => new Promise<void>(resolve => { finish = resolve; }), 5, () => {
    aborts++;
    finish?.();
  });
  assert.deepEqual(result, { timedOut: true });
  assert.equal(aborts, 1);
});

test('OpenHuman manifest loading uses the exact task prompt and rejects paths outside its suite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-account-manifest-'));
  try {
    const suite = join(root, 'suite');
    const taskDir = join(suite, 'django__django-11099');
    mkdirSync(taskDir, { recursive: true });
    const prompt = 'Official benchmark prompt fixture.\n';
    writeFileSync(join(taskDir, 'prompt.txt'), prompt);
    const tasksFile = join(suite, 'tasks.json');
    writeFileSync(tasksFile, JSON.stringify([{ id: 'django__django-11099', image: fixtureImage, workdir: '/testbed', dir: taskDir }]));
    const task = await loadOpenHumanTask(tasksFile, 'django__django-11099');
    assert.equal(task.prompt, prompt);
    assert.equal(task.image, fixtureImage);
    assert.equal(task.workdir, '/testbed');

    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'prompt.txt'), prompt);
    writeFileSync(tasksFile, JSON.stringify([{ id: 'django__django-11099', image: fixtureImage, workdir: '/testbed', dir: outside }]));
    await assert.rejects(loadOpenHumanTask(tasksFile, 'django__django-11099'), /inside the supplied tasks suite/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('task manifest rejects non-official images and workdirs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-account-manifest-'));
  try {
    const taskDir = join(root, 'task');
    mkdirSync(taskDir);
    writeFileSync(join(taskDir, 'prompt.txt'), 'prompt');
    const tasksFile = join(root, 'tasks.json');
    writeFileSync(tasksFile, JSON.stringify([{ id: 'task-1', image: 'ubuntu:latest', workdir: '/testbed', dir: taskDir }]));
    await assert.rejects(loadOpenHumanTask(tasksFile, 'task-1'), /official x86_64 SWE-bench image/);
    writeFileSync(tasksFile, JSON.stringify([{ id: 'task-1', image: fixtureImage, workdir: '/workspace', dir: taskDir }]));
    await assert.rejects(loadOpenHumanTask(tasksFile, 'task-1'), /workdir must be \/testbed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Docker task arguments enforce no network, host mounts, or swap and retain benchmark limits', () => {
  const args = dockerRunArgs(fixtureImage, 'pi-swe-1234-abcd5678');
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--cpus=4'));
  assert.ok(args.includes('--memory=4294967296'));
  assert.ok(args.includes('--memory-swap=4294967296'));
  assert.ok(args.includes('--pids-limit=4096'));
  assert.ok(args.includes('--pull=never'));
  assert.ok(!args.includes('--volume') && !args.includes('-v'));
  assert.ok(!args.some(arg => /api[_-]?key|token/i.test(arg)));
  assert.throws(() => dockerRunArgs('ubuntu:latest', 'pi-swe-1234-abcd5678'), /non-SWE-bench image/);
});

test('container inspection rejects any deviation from the isolated resource policy', () => {
  const good = {
    Image: 'sha256:fixture', Config: { Image: fixtureImage, WorkingDir: '/testbed' },
    HostConfig: { NanoCpus: 4_000_000_000, Memory: 4 * 1024 ** 3, MemorySwap: 4 * 1024 ** 3,
      PidsLimit: 4096, NetworkMode: 'none', Binds: null, Privileged: false },
    Mounts: [], State: { Running: true },
  };
  assert.doesNotThrow(() => assertContainerIsolation(good, fixtureImage));
  assert.throws(() => assertContainerIsolation({ ...good, HostConfig: { ...good.HostConfig, NetworkMode: 'bridge' } }, fixtureImage), /not isolated/);
  assert.throws(() => assertContainerIsolation({ ...good, HostConfig: { ...good.HostConfig, Binds: ['/host:/testbed'] } }, fixtureImage), /Host bind mounts/);
  assert.throws(() => assertContainerIsolation({ ...good, HostConfig: { ...good.HostConfig, Memory: 1024 } }, fixtureImage), /resource limits/);
});

test('container executor confines commands, propagates cancellation, and returns durable timeout status', async () => {
  let args: string[] = [];
  let receivedSignal: AbortSignal | undefined;
  const tool = createContainerExecTool('0123456789ab', async (received, _timeout, signal) => {
    args = received; receivedSignal = signal;
    return { exitCode: 0, stdout: 'inside task container', stderr: '', timedOut: false };
  });
  const response = await tool.execute('call-1', { command: 'printf inside' }, undefined, undefined, {} as never);
  assert.deepEqual(args.slice(0, 6), ['exec', '--workdir', '/testbed', '0123456789ab', 'bash', '-lc']);
  assert.equal(args[6], 'printf inside');
  assert.match(response.content.find(part => part.type === 'text')?.text ?? '', /inside task container/);

  const controller = new AbortController();
  controller.abort();
  const cancelledTool = createContainerExecTool('0123456789ab', async (_received, _timeout, signal) => {
    receivedSignal = signal;
    return { exitCode: 1, stdout: '', stderr: '', timedOut: true };
  });
  const cancelled = await cancelledTool.execute('call-2', { command: 'sleep 600' }, controller.signal, undefined, {} as never);
  assert.equal(receivedSignal, controller.signal);
  assert.equal(cancelled.isError, true);
  assert.match(cancelled.content.find(part => part.type === 'text')?.text ?? '', /command timed out/);
  assert.throws(() => createContainerExecTool('not-a-container'), /Invalid Docker container id/);
});

test('started-container validation failures preserve the cause and cleanup evidence', async () => {
  const good = {
    Config: { Image: fixtureImage, WorkingDir: '/testbed' },
    HostConfig: { NanoCpus: 4_000_000_000, Memory: 4 * 1024 ** 3, MemorySwap: 4 * 1024 ** 3,
      PidsLimit: 4096, NetworkMode: 'none', Binds: null, Privileged: false },
    Mounts: [], State: { Running: true },
  };
  let removals = 0;
  await assert.rejects(validateStartedTaskContainer(async () => {
    assertContainerIsolation({ ...good, HostConfig: { ...good.HostConfig, NetworkMode: 'bridge' } }, fixtureImage);
    return 'unreachable';
  }, async () => { removals++; }), error => {
    assert.ok(error instanceof TaskContainerSetupError);
    assert.match((error.cause as Error).message, /not isolated/);
    assert.match(error.message, /container cleanup succeeded/);
    assert.deepEqual(error.cleanupEvidence, { attempted: true, succeeded: true });
    return true;
  });

  await assert.rejects(validateStartedTaskContainer(async () => {
    return assertCleanBaseline({ ...successfulCommand, stdout: ' M dirty.ts\n' }, { ...successfulCommand, stdout: 'a1b2c3d4e5f6\n' });
  }, async () => { removals++; }), error => {
    assert.ok(error instanceof TaskContainerSetupError);
    assert.match((error.cause as Error).message, /did not start cleanly/);
    assert.match(error.message, /container cleanup succeeded/);
    return true;
  });
  assert.equal(removals, 2);

  const original = new Error('original validation failure');
  await assert.rejects(validateStartedTaskContainer(async () => { throw original; }, async () => {
    throw new Error('Docker removal failed');
  }), error => {
    assert.ok(error instanceof TaskContainerSetupError);
    assert.equal(error.cause, original);
    assert.match(error.message, /original validation failure/);
    assert.match(error.message, /cleanup failed: Docker removal failed/);
    assert.deepEqual(error.cleanupEvidence, { attempted: true, succeeded: false, error: 'Docker removal failed' });
    return true;
  });
});

test('session disposal failure is retained and does not skip container cleanup', async () => {
  let dockerCleanupCalled = false;
  const outcome = await cleanupTaskResources(async () => { throw new Error('session.dispose failed'); }, async () => {
    dockerCleanupCalled = true;
  });
  assert.equal(dockerCleanupCalled, true);
  assert.deepEqual(outcome.session, { attempted: true, succeeded: false, error: 'session.dispose failed' });
  assert.deepEqual(outcome.container, { attempted: true, succeeded: true });
});

test('container cleanup removes retained evidence containers after successful or failed stop', async () => {
  const calls: string[][] = [];
  await stopTaskContainer('0123456789ab', async args => {
    calls.push(args);
    return args[0] === 'stop' ? { ...successfulCommand } : { ...successfulCommand };
  });
  assert.deepEqual(calls.map(args => args[0]), ['stop', 'rm']);

  calls.length = 0;
  await stopTaskContainer('0123456789ab', async args => {
    calls.push(args);
    return args[0] === 'stop' ? { exitCode: 1, stdout: '', stderr: '', timedOut: false } : { ...successfulCommand };
  });
  assert.deepEqual(calls.map(args => args[0]), ['stop', 'rm']);
  await assert.rejects(stopTaskContainer('0123456789ab', async args => ({
    exitCode: 1, stdout: '', stderr: args[0] === 'inspect' ? 'Error: Cannot connect to the Docker daemon' : '', timedOut: false,
  })), /Could not clean up/);
  await assert.doesNotReject(stopTaskContainer('0123456789ab', async args => ({
    exitCode: 1, stdout: '', stderr: args[0] === 'inspect' ? 'Error: No such container: 0123456789ab' : '', timedOut: false,
  })));
});

test('run receipt preserves a failed or timed-out outcome on disk', async () => {
  const receiptFile = await writeRunReceipt({ taskId: 'fixture-task', state: 'timed_out', failures: [{ phase: 'timeout', message: '1200 seconds' }] }, 'fixture-task');
  try {
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    assert.equal(receipt.state, 'timed_out');
    assert.equal(receipt.failures[0].phase, 'timeout');
  } finally { rmSync(dirname(receiptFile), { recursive: true, force: true }); }
});
