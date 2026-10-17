import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { freemem, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSubscriptionAccount, BENCHMARK_MODEL, createRuntime, inspectPiAccount, loadOpenHumanTask, type OpenHumanTask } from './pi-account-benchmark.ts';
import { runTransport } from './optchat-container-transport.ts';
import { BenchmarkCacheTrace } from './benchmark-cache.ts';
// @ts-expect-error JavaScript staging helpers are tested independently.
import { assertSmokeGate, dockerfile, stageContext } from './optchat-container-smoke.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docker = (args: string[], timeout = 30_000) => execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 ** 2 });

export async function snapshotHash(dir: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(path: string, prefix: string) {
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(path, entry.name), `${relative}/`);
      else if (entry.isFile()) hash.update(relative).update('\0').update(await readFile(join(path, entry.name))).update('\0');
      else throw new Error('Runtime snapshots must not contain symlinks.');
    }
  }
  await visit(dir, '');
  return hash.digest('hex');
}

export function taskDockerfile(task: OpenHumanTask): string {
  if (!/^swebench\/sweb\.eval\.x86_64\.[a-z0-9_.-]+:latest$/.test(task.image)) throw new Error('Official task image required.');
  return dockerfile.replace('FROM node:22-slim', 'FROM node:22-slim AS runtime')
    + `\nFROM ${task.image}\nCOPY --from=runtime /usr/local/bin/node /usr/local/bin/node\nCOPY --from=runtime /app /app\nENV HOME=/tmp/home PI_CODING_AGENT_DIR=/tmp/agent OPTCHAT_HOME=/tmp/optchat\n`;
}

export function assertLiveServices(services: { id: string; image: string; cpuPercent: number }[], freeBytes: number) {
  assertSmokeGate('', freeBytes);
  for (const service of services) {
    if (service.image !== 'ghcr.io/github/github-mcp-server' || !Number.isFinite(service.cpuPercent) || service.cpuPercent > 1 || service.cpuPercent < 0) {
      throw new Error('Blocked: another workload is active; leave it untouched.');
    }
  }
}

function liveHostEvidence() {
  const ids = docker(['ps', '-q']).trim().split('\n').filter(Boolean);
  const services = ids.map(id => {
    const image = JSON.parse(docker(['inspect', '--format', '{{json .Config.Image}}', id])) as string;
    const cpu = docker(['stats', '--no-stream', '--format', '{{.CPUPerc}}', id]).trim();
    return { id, image, cpuPercent: Number(cpu.replace('%', '').replace(',', '.')) };
  });
  const freeBytes = freemem();
  assertLiveServices(services, freeBytes);
  return { services, freeBytes, protocol: services.length ? 'shared-idle-github-mcp-service' : 'exclusive-container-slot' };
}

async function runTask(task: OpenHumanTask, source: string) {
  const out = await mkdtemp(join(repo, 'scratchpad/real-optchat-pilot-'));
  const receipt: Record<string, unknown> = { harness: 'OptChat real extension, all tools in container', taskId: task.id, source: resolve(source),
    protocol: 'sequential-4gib-real-optchat-v1', provider: BENCHMARK_MODEL.provider, model: BENCHMARK_MODEL.id, thinking: 'high',
    startedAt: new Date().toISOString(), state: 'preflight', failures: [] };
  const save = () => writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await save();
  console.log(`RECEIPT_DIRECTORY=${out}`);
  const name = `optchat-task-${randomUUID()}`, image = `${name}:local`;
  let built = false, launched = false;
  let context: string | undefined;
  const traces = new Map<string, BenchmarkCacheTrace>();
  try {
    // An idle infrastructure service does not break container isolation. Record it for both A/B variants;
    // unknown containers or a busy service still block. Never stop unrelated work or weaken the RAM gate.
    receipt.hostBeforeBuild = liveHostEvidence();
    receipt.sourceHash = await snapshotHash(source);
    receipt.phase = 'model-runtime';
    const runtime = await createRuntime();
    receipt.phase = 'subscription-preflight';
    const account = await inspectPiAccount(runtime);
    receipt.account = account;
    assertSubscriptionAccount(account);
    const model = runtime.getModel(BENCHMARK_MODEL.provider, BENCHMARK_MODEL.id);
    if (!model) throw new Error('Account-2 Luna model unavailable.');
    receipt.phase = 'runtime-staging';
    context = await mkdtemp(join(tmpdir(), 'oc-real-build-'));
    await cp(source, context, { recursive: true });
    if (await snapshotHash(context) !== receipt.sourceHash) throw new Error('Frozen runtime changed during staging.');
    await writeFile(join(context, 'Dockerfile'), taskDockerfile(task));
    receipt.phase = 'build'; await save();
    docker(['build', '--tag', image, context], 600_000); built = true;
    receipt.hostBeforeInference = liveHostEvidence();
    receipt.phase = 'inference'; receipt.state = 'running'; await save();
    let checkedIsolation = false;
    launched = true;
    const report = await runTransport('docker', ['run', '--interactive', '--name', name, '--network', 'none', '--memory', '4g',
      '--memory-swap', '4g', '--cpus', '4', '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--entrypoint', 'node', image, '--import', '/app/node_modules/tsx/dist/loader.mjs', '/app/test/optchat-container-agent.ts'],
    { kind: 'start', model, cwd: '/testbed', thinking: 'high', prompt: task.prompt, capturePatch: true },
    async function* (modelContext, options) {
      if (!checkedIsolation) {
        const inspected = JSON.parse(docker(['inspect', name]))[0];
        const host = inspected.HostConfig;
        if (host.NetworkMode !== 'none' || host.Memory !== 4 * 1024 ** 3 || host.MemorySwap !== host.Memory
          || host.NanoCpus !== 4e9 || host.Privileged || inspected.Mounts.length || !host.CapDrop.includes('ALL')
          || !host.SecurityOpt.includes('no-new-privileges')) throw new Error('Live container isolation mismatch.');
        receipt.isolation = { network: host.NetworkMode, memory: host.Memory, cpus: host.NanoCpus, hostMounts: 0, imageId: inspected.Image };
        checkedIsolation = true;
      }
      const trace = traces.get(options.sessionId) ?? new BenchmarkCacheTrace();
      traces.set(options.sessionId, trace);
      let traceIndex: number | undefined;
      const stream = runtime.streamSimple(model, modelContext, { ...options,
        onPayload: payload => { traceIndex = trace.request(payload); return undefined; } });
      for await (const event of stream) {
        if (traceIndex !== undefined) {
          if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') trace.delta(event.type, event.delta, undefined, traceIndex);
          if (event.type === 'done') trace.complete(event.message.usage, undefined, traceIndex);
        }
        yield event;
      }
    }, 1_200_000);
    receipt.report = report;
    receipt.state = 'completed-ungraded';
  } catch (error) {
    if (error instanceof Error && 'evidence' in error) receipt.report = error.evidence;
    receipt.state = receipt.phase === 'inference' ? 'failed-no-retry' : 'blocked-before-inference';
    // Never include raw provider/build diagnostics, credentials or URLs from errors in receipts.
    receipt.failures = [{ phase: receipt.phase ?? 'preflight',
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorCode: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : undefined,
      message: error instanceof Error && /Blocked:/.test(error.message) ? error.message : 'Real-harness pilot failed; no retry.' }];
    process.exitCode = 1;
  } finally {
    const cleanupErrors: string[] = [];
    if (launched) {
      try {
        const state = JSON.parse(docker(['inspect', name]))[0].State;
        receipt.containerState = { oomKilled: state.OOMKilled, exitCode: state.ExitCode, running: state.Running };
      } catch { cleanupErrors.push('Container state not observed.'); }
      try { docker(['rm', '--force', name]); } catch { cleanupErrors.push('Container removal not verified.'); }
    }
    if (built) try { docker(['image', 'rm', image]); } catch { cleanupErrors.push('Image removal not verified.'); }
    if (context) try { await rm(context, { recursive: true, force: true }); } catch { cleanupErrors.push('Build context removal failed.'); }
    receipt.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length) { receipt.state = 'cleanup-not-verified'; process.exitCode = 1; }
    receipt.cacheTraces = [...traces.values()].map(trace => trace.requests);
    receipt.finishedAt = new Date().toISOString(); await save();
  }
  console.log(JSON.stringify({ state: receipt.state, failures: receipt.failures }));
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--snapshot') {
    const path = await mkdtemp(join(repo, 'scratchpad/optchat-runtime-'));
    stageContext(repo, path);
    console.log(JSON.stringify({ path, hash: await snapshotHash(path) }, null, 2));
    return;
  }
  if (args.length !== 7 || args[0] !== '--run' || args[1] !== '--tasks-file' || args[3] !== '--task' || args[5] !== '--source') {
    throw new Error('Use --snapshot, or --run --tasks-file <tasks.json> --task <id> --source <frozen-runtime-dir>. No automatic repeats.');
  }
  await runTask(await loadOpenHumanTask(args[2], args[4]), resolve(args[6]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('OptChat benchmark setup failed; no retry.'); process.exitCode = 1; })
    .finally(() => {
      // A one-job CLI is finished after transport cancellation, cleanup and durable receipt writes.
      // Do not keep a completed benchmark alive waiting for provider connection-pool idle timers.
      process.stdout.write('', () => process.stderr.write('', () => process.exit(Number(process.exitCode ?? 0))));
    });
}
