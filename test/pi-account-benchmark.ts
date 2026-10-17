// Opt-in Pi subscription benchmark runner. Preflight never streams a model request.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, getAgentDir, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { lastProfile } from '../src/profiles.ts';
import { BenchmarkCacheTrace, ResponseBudget, LEAN_CONTAINER_INSTRUCTIONS } from './benchmark-cache.js';

export const BENCHMARK_MODEL = { provider: 'openai-codex-account-2', id: 'gpt-6-luna' } as const;
export const REQUESTED_THINKING = 'high' as const;
const TASK_WORKDIR = '/testbed';
const CPU_LIMIT = 4;
const MEMORY_LIMIT_BYTES = 4 * 1024 ** 3; // User-approved sequential low-memory variant, not the published 8 GiB protocol.
const PID_LIMIT = 4096;
const TOOL_OUTPUT_LIMIT = 16_000;
export const SWE_TASK_TIMEOUT_MS = 20 * 60 * 1000; // OpenHuman RUNBOOK.md: TASK_TIMEOUT_S=1200.
const DOCKER_TIMEOUT_MS = SWE_TASK_TIMEOUT_MS;
const MAX_TASK_PROMPT_CHARS = 100_000;

type RuntimeAccess = Pick<ModelRuntime, 'getModel' | 'listCredentials' | 'isUsingOAuth' | 'isUsingSubscription'>;

export interface AccountPreflight {
  provider: string;
  model: string;
  modelRegistered: boolean;
  credentialType: 'oauth' | 'api_key' | null;
  usingOAuth: boolean;
  usingSubscription: boolean;
  eligible: boolean;
  requestedThinking: typeof REQUESTED_THINKING;
  lastSelectedOptChatProfile: string | null;
  liveSessionProfileResolved: false;
  inferencePerformed: false;
  modelNetworkRefreshEnabled: false;
}

export async function inspectPiAccount(runtime: RuntimeAccess, profile: string | null | undefined = lastProfile()): Promise<AccountPreflight> {
  const model = runtime.getModel(BENCHMARK_MODEL.provider, BENCHMARK_MODEL.id);
  const credential = (await runtime.listCredentials()).find(item => item.providerId === BENCHMARK_MODEL.provider);
  const credentialType = credential?.type ?? null;
  const usingOAuth = runtime.isUsingOAuth(BENCHMARK_MODEL.provider);
  const usingSubscription = runtime.isUsingSubscription(BENCHMARK_MODEL.provider);
  return {
    provider: BENCHMARK_MODEL.provider,
    model: BENCHMARK_MODEL.id,
    modelRegistered: model !== undefined,
    credentialType,
    usingOAuth,
    usingSubscription,
    eligible: model !== undefined && credentialType === 'oauth' && usingOAuth && usingSubscription,
    requestedThinking: REQUESTED_THINKING,
    lastSelectedOptChatProfile: profile ?? null,
    liveSessionProfileResolved: false,
    inferencePerformed: false,
    modelNetworkRefreshEnabled: false,
  };
}

export function assertSubscriptionAccount(account: AccountPreflight): void {
  if (!account.modelRegistered) throw new Error(`The selected model is not registered: ${account.provider}/${account.model}.`);
  if (account.credentialType !== 'oauth' || !account.usingOAuth || !account.usingSubscription) {
    throw new Error('This runner requires the selected provider to use a stored OAuth subscription credential; API-key auth is not permitted.');
  }
}

export interface OpenHumanTask {
  id: string;
  image: string;
  workdir: typeof TASK_WORKDIR;
  dir: string;
  prompt: string;
}

const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const imagePattern = /^swebench\/sweb\.eval\.x86_64\.[A-Za-z0-9_.-]+:latest$/;

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function loadOpenHumanTask(tasksFile: string, taskId: string): Promise<OpenHumanTask> {
  if (!taskIdPattern.test(taskId)) throw new Error('Invalid SWE-bench task id.');
  const manifestPath = await realpath(tasksFile);
  const tasksRoot = await realpath(dirname(manifestPath));
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length > 1000) throw new Error('Invalid OpenHuman tasks.json manifest.');
  const matches = parsed.filter((task): task is Record<string, unknown> => typeof task === 'object' && task !== null && task.id === taskId);
  if (matches.length !== 1) throw new Error(matches.length ? 'Task id is duplicated in tasks.json.' : `Task not found in tasks.json: ${taskId}.`);
  const selected = matches[0];
  if (typeof selected.image !== 'string' || !imagePattern.test(selected.image)) throw new Error('Task image is not an official x86_64 SWE-bench image.');
  if (selected.workdir !== TASK_WORKDIR) throw new Error(`Task workdir must be ${TASK_WORKDIR}.`);
  if (typeof selected.dir !== 'string') throw new Error('Task directory is missing.');
  const taskDir = await realpath(selected.dir);
  if (!inside(tasksRoot, taskDir)) throw new Error('Task directory must be inside the supplied tasks suite.');
  const promptPath = await realpath(join(taskDir, 'prompt.txt'));
  if (!inside(taskDir, promptPath)) throw new Error('Task prompt must be inside its task directory.');
  const prompt = await readFile(promptPath, 'utf8');
  if (!prompt.trim() || prompt.length > MAX_TASK_PROMPT_CHARS) throw new Error('Task prompt is empty or unexpectedly large.');
  return { id: taskId, image: selected.image, workdir: TASK_WORKDIR, dir: taskDir, prompt };
}

export function dockerRunArgs(image: string, containerName: string): string[] {
  if (!imagePattern.test(image)) throw new Error('Refusing to run a non-SWE-bench image.');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(containerName)) throw new Error('Invalid task container name.');
  return [
    'run', '--detach', '--pull=never', '--name', containerName,
    `--cpus=${CPU_LIMIT}`, `--memory=${MEMORY_LIMIT_BYTES}`, `--memory-swap=${MEMORY_LIMIT_BYTES}`,
    `--pids-limit=${PID_LIMIT}`, '--network=none', '--workdir', TASK_WORKDIR,
    '--entrypoint', '/bin/bash', image, '-lc', 'sleep infinity',
  ];
}

interface DockerInspect {
  Image?: string;
  Config?: { Image?: string; WorkingDir?: string };
  HostConfig?: {
    NanoCpus?: number;
    Memory?: number;
    MemorySwap?: number;
    PidsLimit?: number;
    NetworkMode?: string;
    Binds?: string[] | null;
    Privileged?: boolean;
    PidMode?: string;
    IpcMode?: string;
  };
  Mounts?: Array<{ Type?: string }>;
  State?: { Running?: boolean };
}

export function assertContainerIsolation(info: DockerInspect, expectedImage: string): void {
  const host = info.HostConfig;
  if (info.Config?.Image !== expectedImage || info.Config.WorkingDir !== TASK_WORKDIR || info.State?.Running !== true) {
    throw new Error('Task container image, workdir, or running state did not match the requested task.');
  }
  if (host?.NanoCpus !== CPU_LIMIT * 1_000_000_000 || host.Memory !== MEMORY_LIMIT_BYTES || host.MemorySwap !== MEMORY_LIMIT_BYTES || host.PidsLimit !== PID_LIMIT) {
    throw new Error('Task container resource limits do not match the benchmark policy.');
  }
  if (host.NetworkMode !== 'none' || host.Privileged === true || host.PidMode === 'host' || host.IpcMode === 'host') {
    throw new Error('Task container is not isolated from host networking or namespaces.');
  }
  if ((host.Binds?.length ?? 0) > 0 || info.Mounts?.some(mount => mount.Type === 'bind')) {
    throw new Error('Host bind mounts are not permitted in task containers.');
  }
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function execFileResult(file: string, args: string[], timeout: number, maxBuffer = 4 * 1024 * 1024, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer, signal }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('Docker CLI is not available on the host.'));
        return;
      }
      const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolve({ exitCode: code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: Boolean(error?.killed) });
    });
  });
}

export function clipped(text: string): string {
  if (text.length <= TOOL_OUTPUT_LIMIT) return text;
  const marker = '\n[output truncated: middle omitted; narrow the command to inspect missing content]\n';
  const remaining = TOOL_OUTPUT_LIMIT - marker.length;
  const head = Math.ceil(remaining / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-(remaining - head))}`;
}

function toolResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text: clipped(text) }], details: {}, ...(isError ? { isError: true } : {}) };
}

type DockerRunner = (args: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<CommandResult>;

export function createContainerExecTool(containerId: string, run: DockerRunner = (args, timeout = DOCKER_TIMEOUT_MS, signal) => execFileResult('docker', args, timeout, 4 * 1024 * 1024, signal)): ToolDefinition {
  if (!/^[a-f0-9]{12,64}$/.test(containerId)) throw new Error('Invalid Docker container id.');
  return {
    name: 'container_exec',
    label: 'Run in SWE task container',
    description: 'Run a shell command only inside the isolated SWE-bench task container at /testbed. The host does not execute the supplied command; the container has no network and no host bind mounts.',
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 12_000 }) }),
    execute: async (_toolCallId, { command }, signal) => {
      const result = await run(['exec', '--workdir', TASK_WORKDIR, containerId, 'bash', '-lc', command], DOCKER_TIMEOUT_MS, signal);
      const output = [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : '', result.timedOut ? '[command timed out]' : '', `[exit code: ${result.exitCode}]`].filter(Boolean).join('\n');
      return toolResult(output, result.exitCode !== 0 || result.timedOut);
    },
  };
}

interface SessionContext {
  session: Awaited<ReturnType<typeof createAgentSession>>['session'];
  cleanup(): Promise<void>;
}

async function createSession(runtime: ModelRuntime, containerId?: string): Promise<SessionContext> {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-account-benchmark-session-'));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true });
  let session: SessionContext['session'] | undefined;
  try {
    await resourceLoader.reload();
    const model = runtime.getModel(BENCHMARK_MODEL.provider, BENCHMARK_MODEL.id);
    if (!model) throw new Error(`The selected model is not registered: ${BENCHMARK_MODEL.provider}/${BENCHMARK_MODEL.id}.`);
    const tool = containerId ? createContainerExecTool(containerId) : undefined;
    session = (await createAgentSession({ cwd, agentDir: getAgentDir(), modelRuntime: runtime, model,
      thinkingLevel: REQUESTED_THINKING, settingsManager, sessionManager: SessionManager.inMemory(), resourceLoader,
      tools: tool ? ['container_exec'] : [], ...(tool ? { customTools: [tool] } : {}) })).session;
    if (session.model?.provider !== BENCHMARK_MODEL.provider || session.model.id !== BENCHMARK_MODEL.id) {
      throw new Error('Pi did not retain the explicitly selected benchmark model.');
    }
    const activeTools = session.getActiveToolNames();
    const callableTools = session.getCallableToolNames();
    if (containerId && (activeTools.length !== 1 || activeTools[0] !== 'container_exec' || callableTools.length !== 1 || callableTools[0] !== 'container_exec')) {
      throw new Error('Benchmark session exposed a tool other than the isolated container executor.');
    }
    if (!containerId && (activeTools.length !== 0 || callableTools.length !== 0)) {
      throw new Error('Preflight session unexpectedly exposed tools.');
    }
    const activeSession = session;
    return { session: activeSession, cleanup: async () => {
      let disposeError: unknown;
      let directoryError: unknown;
      try { await activeSession.dispose(); } catch (error) { disposeError = error; }
      try { await rm(cwd, { recursive: true, force: true }); } catch (error) { directoryError = error; }
      if (disposeError && directoryError) throw new AggregateError([disposeError, directoryError], `Pi session disposal failed (${describeError(disposeError)}) and its temporary directory could not be removed (${describeError(directoryError)}).`);
      if (disposeError) throw disposeError;
      if (directoryError) throw directoryError;
    } };
  } catch (error) {
    let disposeError: unknown;
    let directoryError: unknown;
    if (session) {
      try { await session.dispose(); } catch (cleanupError) { disposeError = cleanupError; }
    }
    try { await rm(cwd, { recursive: true, force: true }); } catch (cleanupError) { directoryError = cleanupError; }
    if (disposeError || directoryError) {
      const cleanupErrors = [disposeError, directoryError].filter(value => value !== undefined);
      const cleanupMessage = [disposeError && `dispose: ${describeError(disposeError)}`, directoryError && `temp directory: ${describeError(directoryError)}`].filter(Boolean).join('; ');
      throw new AggregateError([error, ...cleanupErrors], `Pi session setup failed (${describeError(error)}) and cleanup was incomplete (${cleanupMessage}).`, { cause: error });
    }
    throw error;
  }
}

async function docker(args: string[], timeoutMs = 30_000): Promise<CommandResult> {
  const result = await execFileResult('docker', args, timeoutMs);
  if (result.exitCode !== 0) throw new Error(`Docker operation failed (exit ${result.exitCode}${result.timedOut ? ', timeout' : ''}).`);
  return result;
}

async function ensureImagePresent(image: string): Promise<void> {
  const result = await execFileResult('docker', ['image', 'inspect', '--format', '{{.Id}}', image], 30_000);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(`Task image is not available locally: ${image}. Pull it using the OpenHuman benchmark preparation procedure before running.`);
  }
}

export async function startTaskContainer(task: OpenHumanTask): Promise<{ id: string; imageId: string; baseCommit: string }> {
  await ensureImagePresent(task.image);
  const name = `pi-swe-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started: CommandResult;
  try {
    started = await docker(dockerRunArgs(task.image, name), 120_000);
  } catch (error) {
    const cleanup = await cleanupTaskResources(undefined, () => stopTaskContainer(name));
    throw new TaskContainerSetupError(error, cleanup.container);
  }
  const id = started.stdout.trim();
  if (!/^[a-f0-9]{12,64}$/.test(id)) {
    const cleanup = await cleanupTaskResources(undefined, () => stopTaskContainer(name));
    throw new TaskContainerSetupError(new Error('Docker returned an invalid task container id.'), cleanup.container);
  }
  const validated = await validateStartedTaskContainer(async () => {
    const inspected = await docker(['inspect', id]);
    const info = JSON.parse(inspected.stdout)[0] as DockerInspect;
    assertContainerIsolation(info, task.image);
    if (!info.Image) throw new Error('Docker did not report the task image identity.');
    const statusResult = await executeInContainer(id, 'git -C /testbed status --porcelain', 30_000);
    const commitResult = await executeInContainer(id, 'git -C /testbed rev-parse HEAD', 30_000);
    return { imageId: info.Image, baseCommit: assertCleanBaseline(statusResult, commitResult) };
  }, () => stopTaskContainer(id));
  return { id, ...validated };
}

async function executeInContainer(containerId: string, command: string, timeoutMs = DOCKER_TIMEOUT_MS, maxBuffer?: number): Promise<CommandResult> {
  return execFileResult('docker', ['exec', '--workdir', TASK_WORKDIR, containerId, 'bash', '-lc', command], timeoutMs, maxBuffer);
}

export interface CleanupEvidence {
  attempted: boolean;
  succeeded: boolean;
  error?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown cleanup error.';
}

async function attemptCleanup(cleanup?: () => Promise<void>): Promise<CleanupEvidence> {
  if (!cleanup) return { attempted: false, succeeded: true };
  try {
    await cleanup();
    return { attempted: true, succeeded: true };
  } catch (error) {
    return { attempted: true, succeeded: false, error: describeError(error) };
  }
}

export async function cleanupTaskResources(sessionCleanup?: () => Promise<void>, containerCleanup?: () => Promise<void>): Promise<{ session: CleanupEvidence; container: CleanupEvidence }> {
  const session = await attemptCleanup(sessionCleanup);
  const container = await attemptCleanup(containerCleanup);
  return { session, container };
}

export class TaskContainerSetupError extends Error {
  constructor(cause: unknown, readonly cleanupEvidence: CleanupEvidence) {
    const original = describeError(cause);
    const cleanup = cleanupEvidence.succeeded
      ? 'container cleanup succeeded'
      : `container cleanup failed: ${cleanupEvidence.error ?? 'unknown error'}`;
    super(`Task container setup failed: ${original}; ${cleanup}.`, { cause });
    this.name = 'TaskContainerSetupError';
  }
}

export async function validateStartedTaskContainer<T>(validate: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  try {
    return await validate();
  } catch (error) {
    const evidence = await cleanupTaskResources(undefined, cleanup);
    throw new TaskContainerSetupError(error, evidence.container);
  }
}

export async function stopTaskContainer(containerId: string, run: DockerRunner = (args, timeout = 30_000) => execFileResult('docker', args, timeout)): Promise<void> {
  if (!/^[a-f0-9]{12,64}$/.test(containerId) && !/^pi-swe-\d+-[a-f0-9]{8}$/.test(containerId)) {
    throw new Error('Invalid isolated task container reference.');
  }
  await run(['stop', '--time', '10', containerId], 30_000);
  const removed = await run(['rm', '--force', containerId], 30_000);
  if (removed.exitCode === 0) return;
  const inspected = await run(['inspect', containerId], 30_000);
  if (inspected.exitCode !== 0 && /no such (?:container|object)/i.test(inspected.stderr)) return;
  throw new Error(`Could not clean up isolated task container ${containerId}.`);
}

export function assertCleanBaseline(statusResult: CommandResult, commitResult: CommandResult): string {
  if (statusResult.exitCode !== 0 || statusResult.timedOut || commitResult.exitCode !== 0 || commitResult.timedOut) {
    throw new Error('Could not inspect the SWE-bench task checkout.');
  }
  const commit = commitResult.stdout.trim();
  if (statusResult.stdout.trim() || !/^[a-f0-9]{7,40}$/i.test(commit)) {
    throw new Error('SWE-bench task checkout did not start cleanly.');
  }
  return commit;
}

export async function runWithTaskTimeout(run: () => Promise<void>, timeoutMs: number, abort: () => void): Promise<{ timedOut: boolean; error?: unknown }> {
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    await run();
    return { timedOut };
  } catch (error) {
    return { timedOut, error };
  } finally {
    clearTimeout(deadline);
  }
}

export async function writeRunReceipt(report: object, taskId: string): Promise<string> {
  if (!taskIdPattern.test(taskId)) throw new Error('Invalid receipt task id.');
  const directory = await mkdtemp(join(tmpdir(), 'pi-account-benchmark-result-'));
  const file = join(directory, `${taskId}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return file;
}

export async function runOpenHumanTask(task: OpenHumanTask, runtime: ModelRuntime, account: AccountPreflight): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const failures: Array<{ phase: string; message: string }> = [];
  let phase = 'subscription-preflight';
  let timedOut = false;
  let containerId: string | undefined;
  let imageId: string | undefined;
  let memoryEvidence: unknown = null;
  let sessionContext: SessionContext | undefined;
  let baseCommit: string | undefined;
  let gitStatus = '';
  let patch = '';
  let assistantText = '';
  let actualThinking: string | undefined;
  let supportedThinkingLevels: string[] = [];
  let providerEvidence: unknown = null;
  const cacheTrace = new BenchmarkCacheTrace();
  const responseBudgetMs = 60_000;
  const promptVariant = process.env.PI_BENCHMARK_PROMPT_VARIANT ?? 'baseline';
  if (!['baseline', 'container-lean-v2'].includes(promptVariant)) throw new Error('Unknown benchmark prompt variant.');
  let responseBudget: ResponseBudget | undefined;
  let cleanupEvidence = {
    session: { attempted: false, succeeded: true } as CleanupEvidence,
    container: { attempted: false, succeeded: true } as CleanupEvidence,
  };
  const addFailure = (at: string, error: unknown) => {
    const name = error instanceof Error ? error.name : 'Error';
    const message = at === 'inference' || at === 'session-setup'
      ? `${at} failed; provider diagnostics are omitted to protect credentials (${name}).`
      : error instanceof Error ? error.message : 'Unknown benchmark error.';
    failures.push({ phase: at, message });
  };

  try {
    assertSubscriptionAccount(account);
    phase = 'container-start';
    const container = await startTaskContainer(task);
    containerId = container.id;
    imageId = container.imageId;
    baseCommit = container.baseCommit;

    phase = 'session-setup';
    sessionContext = await createSession(runtime, container.id);
    const session = sessionContext.session;
    actualThinking = session.thinkingLevel;
    supportedThinkingLevels = session.getAvailableThinkingLevels();

    responseBudget = new ResponseBudget(responseBudgetMs, () => { void session.abort(); });
    const budget = responseBudget;
    const previousPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, model) => {
      const replacement = await previousPayload?.(payload, model);
      budget.begin();
      const projected = promptVariant === 'container-lean-v2'
        ? { ...(replacement ?? payload) as object, instructions: LEAN_CONTAINER_INSTRUCTIONS }
        : replacement;
      cacheTrace.request(projected ?? payload);
      return projected;
    };
    session.subscribe(event => {
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent;
        if (update.type === 'text_delta' || update.type === 'thinking_delta' || update.type === 'toolcall_delta') {
          cacheTrace.delta(update.type, update.delta);
        }
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        budget.complete();
        cacheTrace.complete(event.message.usage);
      }
    });
    phase = 'inference';
    const outcome = await runWithTaskTimeout(() => session.prompt(task.prompt), SWE_TASK_TIMEOUT_MS, () => {
      if (session.isStreaming) session.abort();
    });
    timedOut = outcome.timedOut;
    if (outcome.error && !timedOut) addFailure(phase, outcome.error);
    if (responseBudget.exceeded) failures.push({ phase: 'response-budget', message: 'Provider response exceeded the 60-second experimental safety budget; aborted without retry.' });
    if (timedOut) failures.push({ phase: 'timeout', message: 'OpenHuman SWE runbook task timeout reached (1200 seconds); the Pi session was aborted.' });
    assistantText = session.getLastAssistantText() ?? '';
    const replies = session.messages.filter(message => message.role === 'assistant');
    const last = replies.at(-1);
    providerEvidence = {
      assistantResponses: replies.length,
      successfulResponses: replies.filter(message => message.stopReason !== 'error' && message.stopReason !== 'aborted').length,
      finalStopReason: last?.stopReason ?? null,
      usage: replies.map(message => message.usage),
    };
    if (!last || last.stopReason === 'error' || last.stopReason === 'aborted') {
      const quota = /quota|rate.?limit|usage limit|429/i.test(last?.errorMessage ?? '');
      failures.push({ phase: 'provider', message: quota ? 'Provider quota/rate limit; no retry or account switch.' : 'No successful final provider response; raw diagnostics omitted.' });
    }

    phase = 'patch-capture';
    const patchResult = await executeInContainer(container.id, 'git -C /testbed add -N -- . && git -C /testbed diff --binary --no-ext-diff', DOCKER_TIMEOUT_MS, 32 * 1024 * 1024);
    if (patchResult.exitCode !== 0 || patchResult.timedOut) throw new Error('Could not capture the SWE-bench task patch.');
    patch = patchResult.stdout;
    const finalStatus = await executeInContainer(container.id, 'git -C /testbed status --short', 30_000);
    if (finalStatus.exitCode !== 0 || finalStatus.timedOut) throw new Error('Could not capture the SWE-bench task status.');
    gitStatus = finalStatus.stdout;
  } catch (error) {
    if (error instanceof TaskContainerSetupError) cleanupEvidence.container = error.cleanupEvidence;
    addFailure(phase, error);
  } finally {
    responseBudget?.dispose();
    const currentSession = sessionContext;
    const currentContainer = containerId;
    if (currentContainer) {
      try {
        const state = await execFileResult('docker', ['inspect', '--format', '{{json .State}}', currentContainer], 30_000);
        if (state.exitCode !== 0) throw new Error('Container memory state unavailable.');
        const parsed = JSON.parse(state.stdout);
        let memoryEvents: string | null = null;
        let peakBytes: number | null = null;
        if (parsed.Running) {
          const events = await executeInContainer(currentContainer, 'cat /sys/fs/cgroup/memory.events', 10_000);
          if (events.exitCode === 0) memoryEvents = events.stdout;
          const peak = await executeInContainer(currentContainer, 'cat /sys/fs/cgroup/memory.peak', 10_000);
          if (peak.exitCode === 0 && /^\d+$/.test(peak.stdout.trim())) peakBytes = Number(peak.stdout.trim());
        }
        const childOom = memoryEvents?.match(/^oom_kill\s+(\d+)$/m);
        memoryEvidence = { oomKilled: parsed.OOMKilled, exitCode: parsed.ExitCode, running: parsed.Running, memoryEvents, peakBytes };
        if (parsed.OOMKilled === true || Number(childOom?.[1] ?? 0) > 0) failures.push({ phase: 'memory', message: 'Container or child process exceeded the 4 GiB memory limit; no retry.' });
      } catch { memoryEvidence = { unavailable: true }; }
    }
    const cleanup = await cleanupTaskResources(
      currentSession ? () => currentSession.cleanup() : undefined,
      currentContainer ? () => stopTaskContainer(currentContainer) : undefined,
    );
    cleanupEvidence = {
      session: cleanup.session,
      container: currentContainer ? cleanup.container : cleanupEvidence.container,
    };
    if (cleanup.session.attempted && !cleanup.session.succeeded) addFailure('session-cleanup', new Error(cleanup.session.error));
    if (cleanup.container.attempted && !cleanup.container.succeeded) addFailure('container-cleanup', new Error(cleanup.container.error));
  }

  const state = timedOut ? 'timed_out' : failures.length ? 'failed' : 'completed';
  const receipt = {
    taskId: task.id,
    image: task.image,
    imageId: imageId ?? null,
    baseCommit: baseCommit ?? null,
    workdir: task.workdir,
    promptSha256: createHash('sha256').update(task.prompt).digest('hex'),
    model: { provider: BENCHMARK_MODEL.provider, id: BENCHMARK_MODEL.id, requestedThinking: REQUESTED_THINKING,
      actualThinking: actualThinking ?? null, supportedThinkingLevels },
    auth: { credentialType: account.credentialType, usingOAuth: account.usingOAuth, usingSubscription: account.usingSubscription },
    lastSelectedOptChatProfile: account.lastSelectedOptChatProfile,
    executionMode: 'bare-pi-sdk-no-optchat-extension',
    protocolVariant: 'sequential-4gib',
    memoryEvidence,
    providerEvidence,
    cacheTrace: cacheTrace.requests,
    responseBudgetMs,
    experimentVariant: `${promptVariant}-response-60s`,
    taskContainer: { network: 'none', cpus: CPU_LIMIT, memoryBytes: MEMORY_LIMIT_BYTES, swapBytes: 0, pids: PID_LIMIT, hostBindMounts: false },
    state,
    elapsedMs: Date.now() - startedAt,
    cleanup: cleanupEvidence,
    failures,
    gitStatus,
    patch,
    assistantText,
  };
  const receiptFile = await writeRunReceipt(receipt, task.id);
  const summary = { ...receipt, patch: undefined, assistantText: undefined, receiptFile, patchBytes: Buffer.byteLength(patch) };
  if (failures.length) throw new Error(`Benchmark run ${state}; durable receipt: ${receiptFile}`);
  return summary;
}

export async function createRuntime(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  await runtime.refresh({ allowNetwork: false });
  // The bare SDK does not load multi-account extensions. Register only the
  // explicitly selected slot, reusing native Codex auth without copying credentials.
  const base = runtime.getProvider('openai-codex');
  const model = runtime.getModel('openai-codex', BENCHMARK_MODEL.id);
  const oauth = base?.auth.oauth;
  if (!base || !model || !oauth) throw new Error('Native Codex model/OAuth provider is unavailable.');
  runtime.registerProvider(BENCHMARK_MODEL.provider, {
    name: 'Benchmark Codex account 2',
    baseUrl: model.baseUrl,
    api: model.api,
    models: [model],
    oauth: {
      name: 'Codex account 2 subscription',
      isSubscription: true,
      login: async () => { throw new Error('Benchmark cannot initiate login; use the stored account-2 credential.'); },
      refreshToken: (credential, signal) => oauth.refresh({ ...credential, type: 'oauth' }, signal),
      getApiKey: credential => credential.access,
    },
  });
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

async function preflight(): Promise<void> {
  const runtime = await createRuntime();
  const account = await inspectPiAccount(runtime);
  let actualThinking: string | null = null;
  let supportedThinkingLevels: string[] = [];
  if (account.modelRegistered && account.eligible) {
    const context = await createSession(runtime);
    try {
      actualThinking = context.session.thinkingLevel;
      supportedThinkingLevels = context.session.getAvailableThinkingLevels();
    } finally { await context.cleanup(); }
  }
  console.log(JSON.stringify({ ...account, actualThinking, supportedThinkingLevels }, null, 2));
}

function usage(): never {
  throw new Error('Usage: node --import tsx test/pi-account-benchmark.ts --preflight\n       node --import tsx test/pi-account-benchmark.ts --tasks-file <tasks.json> --task <instance-id>');
}

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--preflight') return preflight();
  if (args.length !== 4 || args[0] !== '--tasks-file' || args[2] !== '--task') usage();
  const task = await loadOpenHumanTask(args[1], args[3]);
  const runtime = await createRuntime();
  const account = await inspectPiAccount(runtime);
  assertSubscriptionAccount(account);
  const result = await runOpenHumanTask(task, runtime, account);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    const message = error instanceof Error ? error.message : 'Unknown benchmark error.';
    console.error(`Pi account benchmark failed: ${message}`);
    process.exitCode = 1;
  });
}
