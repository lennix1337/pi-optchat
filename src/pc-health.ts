import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import type { LocalProbe, ProbeResult } from './prod-health.ts';
import { type Remedy, scheduledTask } from './self-fix.ts';

/**
 * This PC as a sense: free disk on the system drive, available memory and whether the daily maintenance task
 * (pc-maintenance skill, report-*.json in %LOCALAPPDATA%\pc-maintenance) still runs. The probes read only; when the
 * disk runs low or the maintenance stops reporting, the remedy starts that same scheduled task ahead of time, the
 * cleaning the operator already runs every night.
 */
export const MAINTENANCE_TASK = 'dotfiles-pc-maintenance';
/** dotfiles payload/tools/offsite-backup: a report-*.json in %LOCALAPPDATA%\optchat-offsite after each copy that worked. */
export const BACKUP_TASK = 'optchat-offsite-backup';
export const DISK_MIN_GB = 30;
export const MEMORY_MIN_FRACTION = 0.05;
export const REPORT_MAX_AGE_MS = 36 * 3_600_000;

/** `dd/mm HH:MM` in Brasília (UTC-3). */
export function brasiliaDayTime(at: number): string {
  const iso = new Date(at - 3 * 3_600_000).toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;
}

const GB = 1e9;
const gb = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;

export interface PcSources {
  drive?: string;
  reportDir?: string;
  now?: () => number;
  disk?: (drive: string) => { free: number; total: number };
  memory?: () => { free: number; total: number };
  reports?: (dir: string) => { name: string; mtimeMs: number }[];
  /** Run when the disk or the maintenance probe goes down; null for none. Default on Windows: the maintenance task. */
  maintenance?: Remedy | null;
  /** Where the offsite backup writes its reports; by default %LOCALAPPDATA%\optchat-offsite when it exists. */
  backupDir?: string;
  /** Run when the backup probe goes down; null for none. Default on Windows: the backup task. */
  backup?: Remedy | null;
}

const realDisk = (drive: string) => { const s = statfsSync(drive); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; };
const realReports = (dir: string) => readdirSync(dir).filter(n => /^report-.*\.json$/.test(n)).map(name => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));

/** A probe that reads a free/total pair and fails below a minimum. */
function capacityProbe(name: string, read: () => { free: number; total: number }, noun: string, minimum: (total: number) => number, limit: (free: number, total: number) => string): LocalProbe {
  return {
    name,
    check(): ProbeResult {
      const { free, total } = read();
      const detail = `${gb(free)} ${noun} de ${gb(total)}`;
      return free < minimum(total) ? { ok: false, ms: 0, detail, problem: `só ${gb(free)} ${noun} (${limit(free, total)})` } : { ok: true, ms: 0, detail };
    },
  };
}

export const diskProbe = (drive: string, disk = realDisk) =>
  capacityProbe(`PC: disco ${drive.replace(/[\\/]+$/, '') || '/'}`, () => disk(drive), 'livres', () => DISK_MIN_GB * GB, () => `mínimo ${DISK_MIN_GB} GB`);

export const memoryProbe = (memory = () => ({ free: freemem(), total: totalmem() })) =>
  capacityProbe('PC: memória', memory, 'disponíveis', total => total * MEMORY_MIN_FRACTION, (free, total) => `${Math.round((free / total) * 100)}%`);

export function maintenanceProbe(dir: string, now: () => number = Date.now, reports = realReports, name = 'PC: manutenção diária'): LocalProbe {
  return {
    name,
    check(): ProbeResult {
      const latest = Math.max(0, ...reports(dir).map(r => r.mtimeMs));
      if (!latest) return { ok: false, ms: 0, problem: `nenhum relatório em ${dir}` };
      const when = brasiliaDayTime(latest);
      return now() - latest > REPORT_MAX_AGE_MS ? { ok: false, ms: 0, detail: `último relatório ${when}`, problem: `não roda desde ${when}` } : { ok: true, ms: 0, detail: `último relatório ${when}` };
    },
  };
}

/** The probes that apply here: the system drive and memory everywhere, the maintenance and backup reports where their tasks write them. */
export function pcProbes(sources: PcSources = {}): LocalProbe[] {
  const drive = sources.drive ?? (process.platform === 'win32' ? `${process.env.SystemDrive ?? 'C:'}\\` : '/');
  const reportDir = sources.reportDir ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'pc-maintenance') : undefined);
  const defaultBackup = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'optchat-offsite') : undefined;
  const backupDir = sources.backupDir ?? (defaultBackup && existsSync(defaultBackup) ? defaultBackup : undefined);
  const task = (given: Remedy | null | undefined, name: string, what: string) => given !== undefined ? given ?? undefined
    : process.platform === 'win32' ? scheduledTask(name, what) : undefined;
  const remedy = task(sources.maintenance, MAINTENANCE_TASK, 'a manutenção do PC');
  const probes = [{ ...diskProbe(drive, sources.disk), remedy }, memoryProbe(sources.memory)];
  if (reportDir) probes.push({ ...maintenanceProbe(reportDir, sources.now, sources.reports), remedy });
  if (backupDir) probes.push({ ...maintenanceProbe(backupDir, sources.now, sources.reports, 'PC: backup na VM'), remedy: task(sources.backup, BACKUP_TASK, 'o backup na VM') });
  return probes;
}
