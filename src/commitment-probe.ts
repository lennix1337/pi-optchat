import { execFile } from 'node:child_process';
import { readCommitments, recordProbe } from './commitments.ts';
import { inferProject, type DueFinding, type ProjectPatterns } from './commitment-due.ts';
import { validateProbe, type Probe } from './probe-policy.ts';

type Execution = { output: string; ok: boolean };
type Executor = (probe: Probe) => Promise<Execution>;
let running = false;
export const executeProbe = (probe: Probe, timeout = 60_000): Promise<Execution> => new Promise(resolve => {
  const [file, ...args] = probe.argv;
  // external: curl -q must be first to suppress the default curlrc.
  if (file === 'curl') args.unshift('-q');
  if (file === 'git') {
    const index = args[0] === '-C' ? 2 : 0, command = args[index];
    if (command === 'show' || command === 'diff') args.splice(index + 1, 0, '--no-ext-diff', '--no-textconv');
    args.unshift('-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false');
  }
  execFile(file, args, { cwd: probe.cwd, timeout, maxBuffer: 4096, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } },  (error, stdout, stderr) => {
    const bytes = Buffer.from(`${stdout}${stderr}${error ? `\n${error.message}` : ''}`);
    let start = Math.max(0, bytes.length - 4096);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    resolve({ ok: !error, output: bytes.subarray(start).toString('utf8') });
  });
});

/** Runs due probes serially, with no shell and no model call. */
export async function runProbes(dir: string, now: number, executor: Executor = executeProbe, patterns: ProjectPatterns = {}): Promise<DueFinding[]> {
  if (running) return [];
  running = true;
  const findings: DueFinding[] = [];
  try {
    for (const item of readCommitments(dir)) {
      const probe = item.probe;
      if (item.status !== 'open' || !probe || item.probeState && now - item.probeState.at < (probe.every ?? 30) * 60_000) continue;
      let result: Execution;
      try { validateProbe(probe, dir); result = await executor(probe); }
      catch (error) { result = { ok: false, output: error instanceof Error ? error.message : String(error) }; }
      const passed = result.ok && new RegExp(probe.expect, 'i').test(result.output);
      const recorded = recordProbe(dir, item.id, probe, result.output, passed, now);
      if (recorded.signal) findings.push({ id: item.id, project: item.project ?? inferProject(item.text, patterns) ?? 'global', kind: 'due', line: `probe failed: ${item.id} ${result.output.slice(-300)}` });
    }
    return findings;
  } finally { running = false; }
}
