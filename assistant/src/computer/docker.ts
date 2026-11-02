import type { Environment } from '../environment/local.ts';
import { localEnvironment } from '../environment/local.ts';

export type DockerResult = { code: number; stdout: string; stderr: string; uncertain?: boolean };
/** Runs the docker CLI with an argv array (never a shell string). Injected so tests can observe the exact arguments. */
export type DockerRunner = (args: readonly string[], options?: { timeoutMs?: number }) => Promise<DockerResult>;

/** The docker CLI through the environment port: only the allow-listed subcommands and flags reach the process. */
export const dockerVia = (environment: Environment): DockerRunner => async (args, options = {}) => {
  const result = await environment.run({ action: 'docker', args: [...args], ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr, uncertain: result.uncertain };
};

export const dockerCli: DockerRunner = dockerVia(localEnvironment);

export type BackendProbe =
  | { available: true; backend: 'docker'; serverVersion: string; os: string; seccomp: boolean; imagePresent: boolean }
  | { available: false; backend: 'docker'; reason: 'engine_unreachable' | 'seccomp_missing' };

/**
 * Reports whether the local Docker engine can host isolated computers, without starting, installing or pulling anything.
 * An absent image is reported, not fetched: provisioning is a separate operator decision.
 */
export async function probeDocker(image: string, docker: DockerRunner = dockerCli): Promise<BackendProbe> {
  const info = await docker(['info', '--format', '{{json .}}'], { timeoutMs: 15_000 });
  if (info.code !== 0) return { available: false, backend: 'docker', reason: 'engine_unreachable' };
  let parsed: { ServerVersion?: string; OperatingSystem?: string; SecurityOptions?: string[] };
  try { parsed = JSON.parse(info.stdout); } catch { return { available: false, backend: 'docker', reason: 'engine_unreachable' }; }
  const seccomp = (parsed.SecurityOptions ?? []).some(option => option.includes('name=seccomp'));
  if (!seccomp) return { available: false, backend: 'docker', reason: 'seccomp_missing' };
  const inspect = await docker(['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 15_000 });
  return { available: true, backend: 'docker', serverVersion: String(parsed.ServerVersion ?? ''), os: String(parsed.OperatingSystem ?? ''), seccomp, imagePresent: inspect.code === 0 };
}
