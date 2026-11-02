import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { planOpen, planRun, type OpenRequest, type Plan, type RunRequest, type RunResult } from './actions.ts';

/**
 * What the service calls instead of spawning: one-shot actions that finish with a result, and long-lived streams whose
 * stdio the caller pipes. Refused requests reject with `EnvironmentRefused` before any process starts.
 */
export interface Environment {
  run(request: RunRequest): Promise<RunResult>;
  open(request: OpenRequest): ChildProcessWithoutNullStreams;
}

export type Spawn = (file: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;

/** Output a one-shot action may produce; a process that exceeds it is killed and reported as uncertain. */
const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * The adapter for this machine: starts the process the allow-list names, in this user's session, without a shell.
 * `launch` is the seam tests use to observe the exact file, arguments, environment and input.
 */
export function createLocalEnvironment(options: { spawn?: Spawn } = {}): Environment {
  const launch: Spawn = options.spawn ?? (spawn as unknown as Spawn);
  return {
    async run(request) { return runPlan(launch, planRun(request)); },
    open(request) {
      const plan = planOpen(request);
      return launch(plan.file, plan.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    },
  };
}

/** The adapter every production call site shares; it holds no state of its own. */
export const localEnvironment: Environment = createLocalEnvironment();

function runPlan(launch: Spawn, plan: Plan): Promise<RunResult> {
  return new Promise(resolve => {
    const child = launch(plan.file, plan.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...plan.env } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), plan.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; if (stdout.length > MAX_OUTPUT) child.kill(); });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; if (stderr.length > MAX_OUTPUT) child.kill(); });
    // A child that exits before reading its input reports through its exit code, not as an unhandled stream error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(plan.stdin ?? '');
    // A process that could not start is reported uncertain, as the Docker runner always did: a caller cannot tell it apart from one that ran.
    child.once('error', () => { clearTimeout(timer); resolve({ code: 1, stdout, stderr, uncertain: true }); });
    child.once('close', exitCode => {
      clearTimeout(timer);
      const code = typeof exitCode === 'number' ? exitCode : 1;
      // A killed child (timeout, output limit) has no exit code; Docker reports its own failures as 125-127. Both may have acted.
      resolve({ code, stdout, stderr, uncertain: exitCode === null || (code >= 125 && code <= 127) });
    });
  });
}
