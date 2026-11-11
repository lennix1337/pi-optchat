import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** What one owner cost the machine in one minute. Nothing here is a secret: owners are names and command heads, never arguments in full. */
export interface LedgerRow {
  /** Start of the minute (Unix ms). */
  t: number;
  /** The cost centre: `worker ed055130`, `shell 3fa9c1`, `bash`, `mcp sentry`, `external chrome.exe`, `Pi host`, or `machine` for the whole PC. */
  owner: string;
  kind: string;
  /** The command head of the owner's heaviest call; absent when the owner has none. */
  detail?: string;
  /** CPU seconds used in the minute. For the `machine` row, all cores' busy time. */
  cpuS: number;
  /** Peak working set in MB. For the `machine` row, the peak memory in use. */
  rssMb: number;
  /** Peak number of processes. */
  procs: number;
  /** Seconds of the minute the owner had a process. */
  wallS: number;
  /** The Pi process whose sampler wrote it (two Pi sessions on one PC both see the machine). */
  host: number;
}

const RETENTION_DAYS = 14;
const dayOf = (t: number) => new Date(t).toLocaleDateString('sv-SE');
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class MachineLedger {
  constructor(private dir: string) {}
  append(rows: LedgerRow[]) {
    if (!rows.length) return;
    mkdirSync(this.dir, { recursive: true });
    const byDay = new Map<string, string[]>();
    for (const row of rows) { const day = dayOf(row.t); byDay.set(day, [...byDay.get(day) ?? [], JSON.stringify(row)]); }
    for (const [day, lines] of byDay) appendFileSync(join(this.dir, `${day}.jsonl`), `${lines.join('\n')}\n`);
  }
  /** The rows from `since` on, in time order. A torn or foreign line is skipped. */
  read(since: number, until = Number.POSITIVE_INFINITY): LedgerRow[] {
    let files: string[];
    try { files = readdirSync(this.dir).filter(f => FILE.test(f)).sort(); } catch { return []; }
    const first = dayOf(since - 24 * 3_600_000), rows: LedgerRow[] = [];
    for (const file of files) {
      if (file.slice(0, 10) < first) continue;
      let text: string;
      try { text = readFileSync(join(this.dir, file), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const row = JSON.parse(line) as LedgerRow;
          if (typeof row.t === 'number' && typeof row.owner === 'string' && typeof row.cpuS === 'number' && row.t >= since && row.t < until) rows.push(row);
        } catch { /* a line cut short by a crash */ }
      }
    }
    return rows.sort((a, b) => a.t - b.t);
  }
  /** Removes day files older than the retention window. Returns the names removed. */
  prune(now: number, days = RETENTION_DAYS): string[] {
    const oldest = dayOf(now - days * 24 * 3_600_000), removed: string[] = [];
    let files: string[];
    try { files = readdirSync(this.dir); } catch { return removed; }
    for (const file of files) {
      const day = FILE.exec(file)?.[1];
      if (day && day < oldest) { try { rmSync(join(this.dir, file)); removed.push(file); } catch { /* in use: the next prune retries */ } }
    }
    return removed;
  }
}

export interface CostCentre { owner: string; kind: string; detail?: string; cpuS: number; peakRssMb: number; avgRssMb: number; peakProcs: number; wallS: number }
/** Cost centres from ledger rows, heaviest CPU first. A command's cost is its own: `bash` rows split by command head, a worker by what it ran. The `machine` row is the total, not a centre. */
export function costCentres(rows: LedgerRow[]): CostCentre[] {
  const centres = new Map<string, CostCentre & { rssSum: number; samples: number }>();
  for (const row of rows) {
    if (row.owner === 'machine') continue;
    const split = row.kind === 'bash' || row.kind === 'shell' || row.kind === 'worker';
    const key = split ? `${row.owner}\u0000${row.detail ?? ''}` : row.owner;
    let centre = centres.get(key);
    if (!centre) centres.set(key, centre = { owner: row.owner, kind: row.kind, detail: split ? row.detail : undefined, cpuS: 0, peakRssMb: 0, avgRssMb: 0, peakProcs: 0, wallS: 0, rssSum: 0, samples: 0 });
    centre.cpuS += row.cpuS; centre.wallS += row.wallS; centre.peakRssMb = Math.max(centre.peakRssMb, row.rssMb); centre.peakProcs = Math.max(centre.peakProcs, row.procs);
    centre.rssSum += row.rssMb; centre.samples++;
  }
  return [...centres.values()].map(({ rssSum, samples, ...c }) => ({ ...c, avgRssMb: samples ? rssSum / samples : 0 })).sort((a, b) => b.cpuS - a.cpuS);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
export const hours = (seconds: number) => seconds >= 3600 ? `${round1(seconds / 3600)} h` : `${Math.round(seconds / 60)} min`;
/**
 * The cost centres of the last `windowMs` as candidates to optimise, each with what it measurably cost: CPU first, then memory that
 * stays resident. External programs are listed but marked: they are not OptChat's to change. Empty when nothing was recorded.
 */
export function machineInsights(rows: LedgerRow[], now: number, windowMs: number, limit = 5): string[] {
  const window = rows.filter(r => r.t >= now - windowMs && r.t < now);
  if (!window.length) return [];
  const centres = costCentres(window), lines: string[] = [];
  const name = (c: CostCentre) => c.detail ? `${c.owner} (${c.detail})` : c.owner;
  const tag = (c: CostCentre) => c.kind === 'external' ? ' [not ours]' : c.kind === 'unattributed' ? ' [owner unknown]' : '';
  for (const c of centres.filter(c => c.cpuS >= 60).slice(0, limit)) lines.push(`cpu: ${name(c)}: ${Math.round(c.cpuS / 60)} cpu-min over ${hours(c.wallS)} alive, up to ${c.peakProcs} procs${tag(c)}`);
  const resident = centres.filter(c => c.avgRssMb >= 150 && c.wallS >= 600).sort((a, b) => b.avgRssMb * b.wallS - a.avgRssMb * a.wallS);
  for (const c of resident.slice(0, limit)) lines.push(`memory: ${name(c)}: ~${Math.round(c.avgRssMb)} MB resident for ${hours(c.wallS)} (${Math.round(c.cpuS / 60)} cpu-min used)${tag(c)}`);
  return lines;
}
