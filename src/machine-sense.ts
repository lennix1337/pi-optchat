import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Attributor, LOWERABLE, commandHead, type McpSignature, type Owner } from './machine-attribution.ts';
import { MachineAlerts, type Frame, type GroupFrame, type Limits } from './machine-alerts.ts';
import { MachineLedger, type LedgerRow } from './machine-ledger.ts';
import type { ProcRow, Sample } from './machine-sample.ts';

/** Windows priority classes (idle 0x40, below normal 0x4000, normal 0x20, above 0x8000, high 0x80, realtime 0x100), lowest first: lowering means moving to a lower rank, never a higher one. */
const RANK = new Map<number, number>([[0x40, 0], [0x4000, 1], [0x20, 2], [0x8000, 3], [0x80, 4], [0x100, 5]]);
const KEEP_FRAMES_MS = 30 * 60_000;
const OPERATOR_ACTIVE_S = 60;
const FRAME_GROUPS = 25;
/** The owners the next Pi process inherits (see `Attributor.remembered`). */
const OWNERS_FILE = 'owners.json';

export interface MachineSenseOptions {
  hostPid: number;
  dir: string;
  threads: number;
  /** Sets a process's priority class for the pid; throws when refused. */
  setPriority: (pid: number, level: 'idle' | 'below-normal') => void;
  /** Delivers an alert or recovery line. Must not throw. */
  notify: (text: string) => void;
  /** Whether our own shells start below normal priority and heavy ones are lowered while the operator works (the `machineLower` setting). */
  lowerOwn: () => boolean;
  mcp?: () => McpSignature[];
  runs?: () => { id: string; started: number }[];
  /** Scaled-down alert thresholds, for a live check on a machine with spare cores. Unset in production. */
  limits?: Partial<Limits>;
}

export interface OwnerNow { group: string; kind: string; detail?: string; cpuPct: number; rssMb: number; procs: number }
export interface MachineNow { t: number; cpu: number | null; memUsedMb: number; memTotalMb: number; idleS: number | null; threads: number; processes: number; owners: OwnerNow[]; lowered: number }
interface Acc { owner: string; kind: string; detail?: string; detailCpu: number; cpuS: number; rssMb: number; procs: number; wallS: number }
interface Pending { minute: number; acc: Map<string, Acc>; cpuS: number; memMb: number; procs: number; wallS: number }

const minuteOf = (t: number) => Math.floor(t / 60_000) * 60_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Everything a sample feeds: attribution, the per-owner CPU and memory of the sample, the minute ledger, the alerts and the
 * priority governor. It never starts or stops anything itself and reads time only from the samples, so tests drive it with a
 * fake process table. Priorities are lowered only for pids that attribution says OptChat started.
 */
export class MachineSense {
  readonly attributor: Attributor;
  readonly ledger: MachineLedger;
  readonly alerts: MachineAlerts;
  private prev?: { t: number; cpuMs: Map<string, number> };
  private owners = new Map<number, Owner>();
  private procs = new Map<number, ProcRow>();
  private frames: { t: number; groups: GroupFrame[]; cpu: number | null; memPct: number }[] = [];
  private pending?: Pending;
  private last?: MachineNow;
  private lowered = new Set<string>();
  private loweredCount = 0;
  private lowerNote = '';
  private prunedDay = '';

  constructor(private options: MachineSenseOptions) {
    this.alerts = new MachineAlerts(options.limits);
    let inherited: unknown;
    try { inherited = JSON.parse(readFileSync(join(options.dir, OWNERS_FILE), 'utf8')); } catch { /* none yet, or torn: start empty */ }
    this.attributor = new Attributor({ hostPid: options.hostPid, mcp: options.mcp, runs: options.runs, inherited });
    this.ledger = new MachineLedger(options.dir);
    this.alerts.actionNote = () => { const note = this.lowerNote; this.lowerNote = ''; return note || undefined; };
  }

  // Recording who started what.
  /** A command of OptChat's began (a bash call, shell_start, a worker's call): its processes belong to `owner`. Returns the handle for `ended`. */
  began(job: { id: string; command: string; mode: 'foreground' | 'background'; agent?: string }, at: number): number {
    const head = commandHead(job.command);
    const owner: Owner = job.agent !== undefined ? { id: job.id, group: `worker ${job.agent.replace(/^agent /, '').slice(0, 8)}`, kind: 'worker', detail: head }
      : job.mode === 'background' ? { id: job.id, group: `shell ${job.id.slice(0, 6)}`, kind: 'shell', detail: head }
        : { id: job.id, group: 'bash', kind: 'bash', detail: head };
    return this.attributor.claim(owner, job.command, at);
  }
  ended(handle: number) { this.attributor.release(handle); }
  /** OptChat's own shell process just started. Below-normal when the setting asks: children inherit the class on Windows. */
  spawned(pid: number, command: string, at: number) {
    this.attributor.bind(pid, command, at);
    if (pid !== this.options.hostPid && this.options.lowerOwn()) { try { this.options.setPriority(pid, 'below-normal'); } catch { /* the shell runs at normal priority rather than not at all */ } }
  }

  /** Lowers `pid` to idle priority only when attribution says OptChat started it. Returns what happened. */
  lowerToIdle(pid: number): 'lowered' | 'already' | 'refused' | 'failed' {
    const proc = this.procs.get(pid), owner = this.owners.get(pid);
    if (!proc || !owner || !LOWERABLE.has(owner.kind) || pid === this.options.hostPid) return 'refused';
    const rank = RANK.get(proc.prio);
    if (rank === undefined || rank <= 0) return 'already';
    try { this.options.setPriority(pid, 'idle'); } catch { return 'failed'; }
    return 'lowered';
  }

  ingest(sample: Sample) {
    const owners = this.attributor.attribute(sample);
    this.owners = owners;
    this.procs = new Map(sample.procs.map(p => [p.pid, p]));
    const dt = this.prev ? (sample.t - this.prev.t) / 1000 : 0;
    const cpuMs = new Map<string, number>();
    const byGroup = new Map<string, { group: string; kind: string; heavy: { detail?: string; cpuS: number }; cpuS: number; rssMb: number; procs: number }>();
    let totalProcs = 0;
    for (const p of sample.procs) {
      if (p.pid === 0) continue;
      totalProcs++;
      const owner = owners.get(p.pid); if (!owner) continue;
      const key = `${p.pid}:${p.start}`;
      cpuMs.set(key, p.cpuMs);
      const before = this.prev?.cpuMs.get(key);
      // A process first seen now started within the interval, so everything it used counts, except on the very first sample.
      const used = !this.prev ? 0 : Math.max(0, (before === undefined ? p.cpuMs : p.cpuMs - before) / 1000);
      let g = byGroup.get(owner.group);
      if (!g) byGroup.set(owner.group, g = { group: owner.group, kind: owner.kind, heavy: { detail: owner.detail, cpuS: -1 }, cpuS: 0, rssMb: 0, procs: 0 });
      g.cpuS += used; g.rssMb += p.workingSetKb / 1024; g.procs++;
      if (owner.detail !== undefined && used > g.heavy.cpuS) g.heavy = { detail: owner.detail, cpuS: used };
    }
    this.prev = { t: sample.t, cpuMs };
    const capacity = dt * this.options.threads;
    const groups: GroupFrame[] = [...byGroup.values()].map(g => ({ group: g.group, kind: g.kind, detail: g.heavy.detail, cpuPct: capacity > 0 ? g.cpuS / capacity * 100 : 0, rssMb: g.rssMb, procs: g.procs }));
    const memPct = sample.memTotalMb > 0 ? sample.memUsedMb / sample.memTotalMb * 100 : 0;
    const cpu = sample.cpu;
    const kept = [...groups].sort((a, b) => b.cpuPct - a.cpuPct || b.rssMb - a.rssMb).slice(0, FRAME_GROUPS);
    this.frames.push({ t: sample.t, groups: kept, cpu, memPct });
    while (this.frames.length && this.frames[0].t < sample.t - KEEP_FRAMES_MS) this.frames.shift();
    this.record(sample, dt, groups, byGroup, cpu, totalProcs);
    const frame: Frame = { t: sample.t, threads: this.options.threads, cpu, memPct, idleS: sample.idleS, groups };
    this.govern(frame);
    for (const text of this.alerts.evaluate(frame)) { try { this.options.notify(text); } catch { /* delivery failed: the ledger still has the numbers */ } }
    this.last = { t: sample.t, cpu, memUsedMb: sample.memUsedMb, memTotalMb: sample.memTotalMb, idleS: sample.idleS, threads: this.options.threads, processes: totalProcs, lowered: this.loweredCount,
      owners: [...groups].sort((a, b) => b.cpuPct - a.cpuPct || b.rssMb - a.rssMb).map(g => ({ ...g })) };
  }

  /** While the machine is saturated and the operator is at the keyboard, OptChat's own heavy trees go to idle priority; nothing else is touched. */
  private govern(frame: Frame) {
    const busy = frame.cpu !== null && frame.cpu >= 90, active = frame.idleS !== null && frame.idleS < OPERATOR_ACTIVE_S;
    if (!busy || !active || !this.options.lowerOwn()) return;
    for (const key of this.lowered) if (!this.procs.has(Number(key.split(':')[0]))) this.lowered.delete(key);
    const heavy = new Set(frame.groups.filter(g => LOWERABLE.has(g.kind as never) && g.cpuPct >= 3).map(g => g.group));
    if (!heavy.size) return;
    const names = new Set<string>(); let count = 0;
    for (const [pid, owner] of this.owners) {
      if (!heavy.has(owner.group)) continue;
      const key = `${pid}:${this.procs.get(pid)?.start}`;
      if (this.lowered.has(key)) continue;
      const result = this.lowerToIdle(pid);
      if (result === 'lowered' || result === 'already') { this.lowered.add(key); }
      if (result === 'lowered') { count++; names.add(owner.group); }
    }
    if (count) { this.loweredCount += count; this.lowerNote = `Operator active: lowered ${count} of our processes (${[...names].join(', ')}) to Idle priority; nothing was stopped.`; }
  }

  // The ledger: one row per owner per minute, written when the minute is over.
  private record(sample: Sample, dt: number, groups: GroupFrame[], byGroup: Map<string, { cpuS: number }>, cpu: number | null, totalProcs: number) {
    const minute = minuteOf(sample.t);
    if (this.pending && this.pending.minute !== minute) this.flush();
    const pending = this.pending ??= { minute, acc: new Map(), cpuS: 0, memMb: 0, procs: 0, wallS: 0 };
    if (dt > 0) {
      pending.wallS += dt;
      if (cpu !== null) pending.cpuS += cpu / 100 * this.options.threads * dt;
    }
    pending.memMb = Math.max(pending.memMb, sample.memUsedMb); pending.procs = Math.max(pending.procs, totalProcs);
    for (const g of groups) {
      const used = byGroup.get(g.group)?.cpuS ?? 0;
      let acc = pending.acc.get(g.group);
      if (!acc) pending.acc.set(g.group, acc = { owner: g.group, kind: g.kind, detail: undefined, detailCpu: -1, cpuS: 0, rssMb: 0, procs: 0, wallS: 0 });
      acc.cpuS += used; acc.rssMb = Math.max(acc.rssMb, g.rssMb); acc.procs = Math.max(acc.procs, g.procs); acc.wallS += dt;
      if (g.detail !== undefined && used >= acc.detailCpu) { acc.detail = g.detail; acc.detailCpu = used; }
    }
  }
  private rows(pending: Pending): LedgerRow[] {
    const host = this.options.hostPid, rows: LedgerRow[] = [{ t: pending.minute, owner: 'machine', kind: 'machine', cpuS: round1(pending.cpuS), rssMb: Math.round(pending.memMb), procs: pending.procs, wallS: Math.round(pending.wallS), host }];
    for (const acc of pending.acc.values()) {
      // Idle externals would only be noise: our own owners always get a row, other programs only when they cost something.
      if ((acc.kind === 'external' || acc.kind === 'unattributed') && acc.cpuS < 0.5 && acc.rssMb < 150) continue;
      if (acc.cpuS < 0.05 && acc.rssMb < 50 && acc.kind !== 'mcp') continue;
      rows.push({ t: pending.minute, owner: acc.owner, kind: acc.kind, ...acc.detail ? { detail: acc.detail } : {}, cpuS: round1(acc.cpuS), rssMb: Math.round(acc.rssMb), procs: acc.procs, wallS: Math.round(acc.wallS), host });
    }
    return rows;
  }
  /** Writes the finished minute (or, at shutdown, the one in progress). A disk failure is returned, not thrown: the sampler must outlive it. */
  flush(): Error | undefined {
    this.saveOwners();
    const pending = this.pending; this.pending = undefined;
    if (!pending || pending.wallS <= 0) return undefined;
    const day = new Date(pending.minute).toLocaleDateString('sv-SE');
    if (day !== this.prunedDay) { this.prunedDay = day; this.ledger.prune(pending.minute); }
    try { this.ledger.append(this.rows(pending)); return undefined; } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  }

  private saveOwners() {
    const file = join(this.options.dir, OWNERS_FILE);
    try { writeFileSync(`${file}.tmp`, JSON.stringify(this.attributor.remembered())); renameSync(`${file}.tmp`, file); } catch { /* the next minute retries; at worst a restart reads its leftovers as external */ }
  }

  /** Collection sizes for `heap_report`. */
  sizes() {
    const a = this.attributor.sizes();
    return { machineFrames: this.frames.length, machineProcs: this.procs.size, machineOwners: this.owners.size, machineClaims: a.claims, machineMemo: a.memo, machineBound: a.bound,
      machineExternals: a.externals, machineUnattributed: a.unattributed, machineLowered: this.lowered.size, machinePendingOwners: this.pending?.acc.size ?? 0 };
  }

  // Reading it back.
  now(): MachineNow | undefined { return this.last; }
  /** Ledger rows from `since` on, plus the minute not yet written. */
  history(since: number): LedgerRow[] {
    const rows = this.ledger.read(since);
    if (this.pending && this.pending.wallS > 0) rows.push(...this.rows(this.pending).filter(r => r.t >= since));
    return rows;
  }
}
