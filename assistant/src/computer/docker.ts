import { execFile } from 'node:child_process';

export type DockerResult = { code: number; stdout: string; stderr: string; uncertain?: boolean };
/** Runs the docker CLI with an argv array (never a shell string). Injected so tests can observe the exact arguments. */
export type DockerRunner = (args: readonly string[], options?: { timeoutMs?: number }) => Promise<DockerResult>;

export const dockerCli: DockerRunner = (args, options = {}) => new Promise(resolve => {
  execFile('docker', [...args], { timeout: options.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
    const uncertain = !!error && (typeof (error as { code?: unknown }).code !== 'number' || code >= 125 && code <= 127);
    resolve({ code, stdout, stderr, uncertain });
  });
});

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
