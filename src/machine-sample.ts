import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { constants as osConstants, setPriority } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { HELPER_SOURCE } from './machine-helper-source.ts';

/** One process of a sample. `start` is its creation time (Unix ms): with the pid it names one process for good, since pids are reused. */
export interface ProcRow {
  pid: number; ppid: number; start: number; name: string;
  /** CPU time used so far, kernel + user. */
  cpuMs: number;
  workingSetKb: number;
  /** Windows priority class (0x40 idle, 0x4000 below normal, 0x20 normal, 0x8000 above normal, 0x80 high, 0x100 realtime); 0 when unreadable. */
  prio: number;
  /** The command line, only on the first sample of a process in the sampler's tree, cut to 200 characters. */
  cmd?: string;
}
export interface Sample {
  t: number;
  /** Machine CPU busy over the interval since the previous sample, 0-100; null on the first sample. */
  cpu: number | null;
  memUsedMb: number; memTotalMb: number;
  /** Seconds since the operator's last keyboard or mouse input; null when unreadable. */
  idleS: number | null;
  helperPid: number;
  procs: ProcRow[];
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** One helper line as a Sample, or undefined for anything that is not a well-formed sample (a torn line, a banner). */
export function parseSampleLine(line: string): Sample | undefined {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return undefined; }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { t, cpu, mem, idle, pid, p } = raw as Record<string, unknown>;
  if (!finite(t) || !Array.isArray(mem) || !finite(mem[0]) || !finite(mem[1]) || !finite(pid) || !Array.isArray(p)) return undefined;
  const procs: ProcRow[] = [];
  for (const row of p) {
    if (!Array.isArray(row) || !finite(row[0]) || !finite(row[1]) || !finite(row[2]) || typeof row[3] !== 'string' || !finite(row[4]) || !finite(row[5]) || !finite(row[6])) continue;
    procs.push({ pid: row[0], ppid: row[1], start: row[2], name: row[3], cpuMs: row[4], workingSetKb: row[5], prio: row[6], ...typeof row[7] === 'string' ? { cmd: row[7] } : {} });
  }
  return { t, cpu: finite(cpu) ? cpu : null, memUsedMb: mem[0], memTotalMb: mem[1], idleS: finite(idle) ? idle : null, helperPid: pid, procs };
}

export interface SamplerStatus { state: 'starting' | 'running' | 'unsupported' | 'failed' | 'stopped'; detail?: string }
export interface SamplerOptions {
  /** Where the compiled helper lives (`<dir>/bin`). */
  dir: string; rootPid: number; intervalMs: number;
  onSample(sample: Sample): void;
  onStatus?(status: SamplerStatus): void;
}

const csc = () => [join(process.env.windir ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(process.env.windir ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find(existsSync);

/** The compiled helper, built once from HELPER_SOURCE by the .NET Framework compiler every Windows has, and named by the source's hash so an update rebuilds it. */
export function ensureHelper(dir: string): Promise<string> {
  const bin = join(dir, 'bin'), name = `sampler-${createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 10)}`, exe = join(bin, `${name}.exe`);
  if (existsSync(exe)) return Promise.resolve(exe);
  const compiler = csc();
  if (!compiler) return Promise.reject(new Error('the .NET Framework compiler (csc.exe) was not found'));
  mkdirSync(bin, { recursive: true });
  const source = join(bin, `${name}.cs`), tmp = join(bin, `${name}.${process.pid}.tmp.exe`);
  writeFileSync(source, HELPER_SOURCE);
  return new Promise((resolve, reject) => execFile(compiler, ['-nologo', '-optimize', '-platform:x64', `-out:${tmp}`, source], { windowsHide: true, timeout: 60_000 }, (error, stdout) => {
    if (error) return reject(new Error(`the helper did not compile: ${(stdout || error.message).trim().split('\n')[0]}`));
    try { renameSync(tmp, exe); } catch (renameError) { if (!existsSync(exe)) return reject(renameError instanceof Error ? renameError : new Error(String(renameError))); }
    resolve(exe);
  }));
}

/**
 * The long-lived helper and its stdout lines. It runs at the lowest priority, ends when this process does (its stdin
 * closes) and is restarted a few times if it dies. Only Windows has a helper: elsewhere the status says so and nothing runs.
 */
export class HelperSampler {
  private child?: ChildProcess;
  private stopped = false;
  private restarts = 0;
  status: SamplerStatus = { state: 'starting' };
  constructor(private options: SamplerOptions) {}
  private set(status: SamplerStatus) { this.status = status; this.options.onStatus?.(status); }
  async start() {
    if (process.platform !== 'win32') return this.set({ state: 'unsupported', detail: `only Windows has a sampler (platform ${process.platform})` });
    try { this.launch(await ensureHelper(this.options.dir)); } catch (error) { this.set({ state: 'failed', detail: error instanceof Error ? error.message : String(error) }); }
  }
  private launch(exe: string) {
    if (this.stopped) return;
    const child = spawn(exe, [String(this.options.rootPid), String(this.options.intervalMs)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child = child;
    child.stdin?.on('error', () => {}); child.stdout?.on('error', () => {});
    if (child.pid) { try { setPriority(child.pid, osConstants.priority.PRIORITY_LOW); } catch { /* the sampler runs at normal priority rather than not at all */ } }
    createInterface({ input: child.stdout! }).on('line', line => {
      const sample = parseSampleLine(line);
      if (!sample) return;
      if (this.status.state !== 'running') { this.restarts = 0; this.set({ state: 'running' }); }
      try { this.options.onSample(sample); } catch (error) { this.set({ state: 'running', detail: `a sample was not processed: ${error instanceof Error ? error.message : String(error)}` }); }
    });
    child.once('error', error => this.set({ state: 'failed', detail: error.message }));
    child.once('exit', code => {
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      if (this.restarts >= 3) return this.set({ state: 'failed', detail: `the helper exited (code ${code}) ${this.restarts + 1} times in a row` });
      this.restarts++;
      const retry = setTimeout(() => this.launch(exe), 2_000 * this.restarts); retry.unref?.();
    });
  }
  stop() {
    this.stopped = true;
    const child = this.child; this.child = undefined;
    if (child) { try { child.stdin?.end(); child.kill(); } catch { /* it already ended */ } }
    this.set({ state: 'stopped' });
  }
}
