import { readFileSync } from 'node:fs';
import { cpus, constants, setPriority } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { McpSignature } from './machine-attribution.ts';
import { costCentres, hours, machineInsights, type LedgerRow } from './machine-ledger.ts';
import { HelperSampler, type SamplerStatus } from './machine-sample.ts';
import { MachineSense, type MachineNow, type MachineSenseOptions } from './machine-sense.ts';
import { dataHome } from './profiles.ts';

const SAMPLE_MS = 5_000;
/** One sampler per Pi process, shared by the shell tools that tell it who started what. A /reload re-evaluates the extension, so the handle lives on a global symbol. */
const SERVICE = Symbol.for('pi-optchat.machine-service');
const holder = globalThis as typeof globalThis & { [SERVICE]?: MachineService };

export const machineDir = () => join(dataHome(), 'machine');
/** The running service of this Pi process, or undefined (a worker, a one-shot run, another platform). */
export const machineService = () => holder[SERVICE];

/** What mcp.json defines, as the words each server's command line holds (package names; versions and flags left out). */
export function mcpSignatures(file: string): McpSignature[] {
  let servers: unknown;
  try { servers = (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: unknown }).mcpServers; } catch { return []; }
  if (typeof servers !== 'object' || servers === null) return [];
  return Object.entries(servers as Record<string, { command?: unknown; args?: unknown }>).flatMap(([name, config]) => {
    const args = Array.isArray(config?.args) ? config.args.filter((a): a is string => typeof a === 'string' && !a.startsWith('-')) : [];
    const words = [...args, typeof config?.command === 'string' ? config.command.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '') : '']
      .map(w => w.replace(/(?<=.)(@|==)[\w.\-+]+$/, '')).filter(w => w.length >= 6 && !/^(npx|uvx|node|python|stdio)$/i.test(w));
    return words.length ? [{ name, tokens: [...new Set(words)] }] : [];
  });
}

export interface ServiceOptions {
  agentDir: string;
  notify: (text: string) => void;
  lowerOwn: () => boolean;
  runs: () => { id: string; started: number }[];
  dir?: string;
  limits?: MachineSenseOptions['limits'];
}

export class MachineService {
  readonly sense: MachineSense;
  private sampler: HelperSampler;
  private state: SamplerStatus = { state: 'starting' };
  private constructor(options: ServiceOptions) {
    const priority = constants.priority;
    this.sense = new MachineSense({
      hostPid: process.pid, dir: options.dir ?? machineDir(), threads: Math.max(1, cpus().length), notify: options.notify, limits: options.limits, lowerOwn: options.lowerOwn, runs: options.runs,
      mcp: () => mcpSignatures(join(options.agentDir, 'mcp.json')),
      setPriority: (pid, level) => setPriority(pid, level === 'idle' ? priority.PRIORITY_LOW : priority.PRIORITY_BELOW_NORMAL),
    });
    this.sampler = new HelperSampler({ dir: options.dir ?? machineDir(), rootPid: process.pid, intervalMs: SAMPLE_MS,
      onSample: sample => { try { this.sense.ingest(sample); } catch { /* a bad sample must not stop the next one */ } },
      onStatus: status => { this.state = status; } });
  }
  get status() { return this.state; }
  /** Starts the sampler of this process, replacing one a /reload left behind. */
  static start(options: ServiceOptions) {
    holder[SERVICE]?.stop();
    const service = holder[SERVICE] = new MachineService(options);
    void service.sampler.start().catch(error => { service.state = { state: 'failed', detail: error instanceof Error ? error.message : String(error) }; });
    return service;
  }
  stop() {
    this.sampler.stop();
    this.sense.flush();
    if (holder[SERVICE] === this) holder[SERVICE] = undefined;
  }
  /** The last 24 h or `days` of the ledger as candidate optimisations, for the daily retro. */
  insights(windowMs: number, now = Date.now()) { return machineInsights(this.sense.history(now - windowMs), now, windowMs); }
}

// ---- the read-only `machine` tool ----

const pct = (n: number | null) => n === null ? '?' : `${Math.round(n)}%`;
const gb = (mb: number) => (mb / 1024).toFixed(1);
const clock = (t: number) => new Date(t).toLocaleTimeString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const head = (text: string | undefined) => text ? ` ${text}` : '';

export function renderNow(now: MachineNow | undefined, status: SamplerStatus, limit = 8): string {
  if (!now) return `machine sampler: ${status.state}${status.detail ? ` (${status.detail})` : ''}. No sample yet.`;
  const lines = [`${clock(now.t)} cpu ${pct(now.cpu)} of ${now.threads} threads, memory ${gb(now.memUsedMb)}/${gb(now.memTotalMb)} GB (${Math.round(now.memUsedMb / now.memTotalMb * 100)}%), ${now.processes} processes, operator idle ${now.idleS === null ? '?' : `${Math.round(now.idleS)} s`}${now.lowered ? `, ${now.lowered} of ours lowered to Idle` : ''}`];
  const shown = now.owners.filter(o => o.cpuPct >= 0.5 || o.rssMb >= 150).slice(0, limit);
  lines.push('owner | kind | cpu% of machine | MB | procs');
  for (const o of shown) lines.push(`${o.group}${head(o.detail)} | ${o.kind} | ${o.cpuPct.toFixed(1)} | ${Math.round(o.rssMb)} | ${o.procs}`);
  if (now.owners.length > shown.length) lines.push(`(${now.owners.length - shown.length} more owners under 0.5% CPU and 150 MB)`);
  return lines.join('\n');
}

export function renderTop(rows: LedgerRow[], windowMin: number, limit = 8, kind?: string): string {
  const centres = costCentres(kind ? rows.filter(r => r.kind === kind) : rows);
  if (!centres.length) return `No machine rows in the last ${windowMin} min.`;
  const machine = rows.filter(r => r.owner === 'machine'), total = machine.reduce((s, r) => s + r.cpuS, 0);
  const lines = [`last ${windowMin} min, ${machine.length} min recorded, machine ${Math.round(total / 60)} cpu-min`, 'owner | kind | cpu-min | avg MB | peak procs | alive'];
  for (const c of centres.slice(0, limit)) lines.push(`${c.owner}${head(c.detail)} | ${c.kind} | ${(c.cpuS / 60).toFixed(1)} | ${Math.round(c.avgRssMb)} | ${c.peakProcs} | ${hours(c.wallS)}`);
  return lines.join('\n');
}

export function renderHistory(rows: LedgerRow[], owner: string, windowMin: number): string {
  const needle = owner.toLowerCase(), mine = rows.filter(r => r.owner.toLowerCase().includes(needle) || (r.detail ?? '').toLowerCase().includes(needle));
  if (!mine.length) return `No rows for "${owner}" in the last ${windowMin} min.`;
  const bucket = windowMin > 180 ? 60 : 10, byBucket = new Map<number, LedgerRow[]>();
  for (const r of mine) { const key = Math.floor(r.t / (bucket * 60_000)) * bucket * 60_000; (byBucket.get(key) ?? byBucket.set(key, []).get(key)!).push(r); }
  const lines = [`${mine[0].owner}${mine.some(r => r.owner !== mine[0].owner) ? ' and others matching' : ''}: ${bucket}-min buckets`, 'time | cpu-s | peak MB | peak procs'];
  for (const [t, group] of [...byBucket].sort((a, b) => a[0] - b[0]).slice(-48))
    lines.push(`${new Date(t).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(5, 16)} | ${Math.round(group.reduce((s, r) => s + r.cpuS, 0))} | ${Math.max(...group.map(r => r.rssMb))} | ${Math.max(...group.map(r => r.procs))}`);
  return lines.join('\n');
}

export const machineTool = (service: () => MachineService | undefined) => ({
  name: 'machine', label: 'Machine', exposure: 'deferred' as const, annotations: { readOnlyHint: true },
  description: 'What this PC is doing and who in OptChat\'s trees causes it (read-only). now: CPU, memory and owners at the last 5 s sample. top: owners by CPU over a window (minutes, default 60). history: one owner\'s minute rows over a window (owner = part of a name or command). Ledger is ~/.optchat/machine, 14 days.',
  parameters: Type.Object({
    view: Type.Optional(Type.Union([Type.Literal('now'), Type.Literal('top'), Type.Literal('history')], { description: 'Default now.' })),
    window: Type.Optional(Type.Number({ minimum: 1, maximum: 20160, description: 'Minutes back for top and history.' })),
    owner: Type.Optional(Type.String({ description: 'history: part of an owner name or command head, e.g. "sentry" or "stress.sh".' })),
    kind: Type.Optional(Type.String({ description: 'top: only this kind (worker, shell, bash, mcp, own, external).' })),
  }, { additionalProperties: false }),
  async execute(_id: string, args: { view?: 'now' | 'top' | 'history'; window?: number; owner?: string; kind?: string }) {
    const svc = service();
    const text = (() => {
      if (!svc) return 'The machine sampler is not running in this session (it runs in the main Pi session on Windows).';
      const view = args.view ?? 'now', window = args.window ?? (view === 'history' ? 180 : 60);
      if (view === 'now') return renderNow(svc.sense.now(), svc.status);
      const since = (svc.sense.now()?.t ?? Date.now()) - window * 60_000;
      if (view === 'top') return renderTop(svc.sense.history(since), window, 8, args.kind);
      return args.owner ? renderHistory(svc.sense.history(since), args.owner, window) : 'history needs owner.';
    })();
    return { content: [{ type: 'text' as const, text }], details: {} };
  },
});
