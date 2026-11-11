// Feeds MachineSense hours of synthetic 5-second samples (a busy machine: 330 processes, 10% of them replaced every sample, a shell
// claim every minute, now and then a heavy worker) into a temp ledger directory, and prints heap after two collections and the
// collection sizes every simulated hour. Offline: no sampler helper, no network, nothing outside os.tmpdir().
//   node --experimental-transform-types --expose-gc scripts/machine-bench.ts [--hours 24]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineSense } from '../src/machine-sense.ts';
import type { ProcRow, Sample } from '../src/machine-sample.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const hours = Number(arg('hours', '24'));
if (typeof globalThis.gc !== 'function') throw new Error('run with --expose-gc');
const HOST = 100, HELPER = 101, THREADS = 16, INTERVAL = 5_000, PER_HOUR = 3_600_000 / INTERVAL;
const dir = mkdtempSync(join(tmpdir(), 'machine-bench-'));
let alerts = 0;
const sense = new MachineSense({ hostPid: HOST, dir, threads: THREADS, notify: () => { alerts++; }, lowerOwn: () => true, setPriority: () => {},
  mcp: () => [{ name: 'codemode', tokens: ['codemode'] }], runs: () => [] });

let t = Date.parse('2026-11-10T21:00:00Z'), nextPid = 1000;
const procs = new Map<number, ProcRow>();
const spawn = (pid: number, ppid: number, name: string, cmd?: string) => procs.set(pid, { pid, ppid, start: t, name, cpuMs: 0, workingSetKb: 40_000, prio: 0x20, ...cmd ? { cmd } : {} });
spawn(HOST, 1, 'node.exe'); spawn(HELPER, HOST, 'sampler.exe');
const names = ['chrome.exe', 'Code.exe', 'svchost.exe', 'node.exe', 'git.exe', 'bash.exe', 'conhost.exe', 'dotnet.exe', 'msedge.exe', 'python.exe'];
for (let i = 0; i < 328; i++) spawn(nextPid++, i % 3 === 0 ? HOST : 1, names[i % names.length], i % 3 === 0 ? `cmd ${i}` : undefined);

const mb = (n: number) => Math.round(n / 104857.6) / 10;
const rows: unknown[] = [], held: number[] = [];
function report(hour: number) {
  globalThis.gc!(); globalThis.gc!();
  const row = { hour, heapMB: mb(process.memoryUsage().heapUsed), alerts, ...sense.sizes() };
  rows.push(row); console.log(JSON.stringify(row));
}
report(0);
for (let hour = 1; hour <= hours; hour++) {
  for (let n = 0; n < PER_HOUR; n++) {
    t += INTERVAL;
    const ids = [...procs.keys()].filter(pid => pid > HELPER);
    for (let k = 0; k < 33; k++) { const pid = ids[(n * 7 + k * 11) % ids.length]; procs.delete(pid); spawn(nextPid++, k % 3 === 0 ? HOST : 1, names[k % names.length], k % 3 === 0 ? `cmd ${nextPid}` : undefined); }
    for (const p of procs.values()) p.cpuMs += p.pid % 5 === 0 ? 400 : 20;
    if (n % 12 === 0) held.push(sense.began({ id: `job-${hour}-${n}`, command: `echo ${n}`, mode: 'background' }, t));
    if (n % 12 === 2) for (const handle of held.splice(0)) sense.ended(handle);
    const sample: Sample = { t, cpu: 30 + (n % 60), memUsedMb: 12_000, memTotalMb: 32_000, idleS: n % 7 === 0 ? 2 : 90, helperPid: HELPER, procs: [...procs.values()].map(p => ({ ...p })) };
    sense.ingest(sample);
  }
  report(hour);
}
sense.flush();
rmSync(dir, { recursive: true, force: true });
