import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { freemem, totalmem, uptime } from 'node:os';
import { delimiter, join } from 'node:path';
import type { MachineNow } from './machine-sense.ts';
import type { Facts, Load, QuotaAccount, Reboot, Sources } from './situation.ts';

/**
 * The readers behind the situation digest: each one cheap, read-only and local (the Windows event log, `docker info`, two
 * registry keys, the quota file pi-multi-account keeps, the state pi-gitwatch keeps, the machine sampler's last sample). Parsers
 * are pure so tests feed them text; the process and file access is injected.
 */

const MIN = 60_000;
const DAY = 24 * 3_600_000;

// ---- Windows reboots ----

interface RawEvent { t: number; id: number; m?: string }

const UPDATE = /MoUsoCoreWorker|TrustedInstaller|wuauclt|MusNotification|WaaSMedic|SetupHost|usoclient|UpdateAssistant/i;
const PERSON = /StartMenuExperienceHost|explorer\.exe|shutdown\.exe|ShellExperienceHost|SearchHost|sihost/i;

/** Why a 1074 event says the PC shut down: the process that asked, in words. */
export function rebootCause(message: string | undefined): string | undefined {
  const exe = /([\w.\-]+\.exe)/i.exec(message ?? '')?.[1];
  if (!exe) return undefined;
  return UPDATE.test(exe) ? 'Windows Update' : PERSON.test(exe) ? 'pelo usuário' : exe.replace(/\.exe$/i, '');
}

/** Reboots from the System log's events 6005 (log started: the PC is up), 6006/1074 (clean stop, who asked) and 41/6008 (it died without saying). */
export function parseReboots(json: string, now: number): Reboot[] {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  const events = (Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [])
    .filter((e): e is RawEvent => typeof (e as RawEvent)?.t === 'number' && typeof (e as RawEvent)?.id === 'number').sort((a, b) => a.t - b.t);
  const reboots: Reboot[] = [];
  let before: { down?: number; cause?: string } = {};
  for (const event of events) {
    if (event.id === 1074) { before.down ??= event.t; before.cause ??= rebootCause(event.m); }
    else if (event.id === 6006) before.down ??= event.t;
    else if (event.id === 6005) { reboots.push({ up: event.t, ...before.down !== undefined ? { down: before.down } : {}, ...before.cause ? { cause: before.cause } : {}, unexpected: false }); before = {}; }
  }
  for (const event of events.filter(e => e.id === 41 || e.id === 6008)) {
    const near = reboots.find(r => Math.abs(r.up - event.t) < 15 * MIN);
    if (!near) reboots.push({ up: event.t, unexpected: true });
    else if (near.down === undefined) near.unexpected = true;
  }
  return reboots.filter(r => r.up >= now - DAY).sort((a, b) => a.up - b.up);
}

const EVENT_SCRIPT = [
  "$e=@(Get-WinEvent -FilterHashtable @{LogName='System';Id=41,6005,6006,6008,1074;StartTime=(Get-Date).AddHours(-26)} -ErrorAction SilentlyContinue |",
  "ForEach-Object { [pscustomobject]@{ t=([DateTimeOffset]$_.TimeCreated).ToUnixTimeMilliseconds(); id=$_.Id; m=$_.Message.Substring(0,[Math]::Min(260,$_.Message.Length)) } });",
  'ConvertTo-Json -Compress -InputObject $e',
].join(' ');
const encoded = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

// ---- quota ----

const windowLabel = (seconds: unknown) => typeof seconds !== 'number' || !(seconds > 0) ? '?' : seconds % 86_400 === 0 ? `${seconds / 86_400}d` : `${Math.round(seconds / 3_600)}h`;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The windows pi-multi-account measured per provider (primary: hours, secondary: days) and any cooldown it set. A key-billed plan has no window. */
export function parseQuota(state: unknown, now: number): QuotaAccount[] {
  const data = record(state), usage = record(data.usageByProvider), cooldowns = record(data.exhaustedUntilByProvider);
  return Object.entries(usage).flatMap(([id, value]) => {
    const entry = record(value);
    const windows = (['primary', 'secondary'] as const).flatMap(name => {
      const w = record(entry[name]);
      return typeof w.usedPercent === 'number' ? [{ label: windowLabel(w.windowSeconds), used: w.usedPercent, ...typeof w.resetAt === 'number' ? { resetAt: w.resetAt } : {} }] : [];
    });
    const until = cooldowns[id];
    const exhaustedUntil = typeof until === 'number' && until > now ? until : undefined;
    return windows.length || exhaustedUntil !== undefined ? [{ id, ...typeof entry.plan === 'string' ? { plan: entry.plan } : {}, windows, ...exhaustedUntil !== undefined ? { exhaustedUntil } : {} }] : [];
  });
}

// ---- gitwatch ----

/** pi-gitwatch's own failure counter: GitHub is out when at least half of the watched repos failed its notice threshold in a row. */
export const GITWATCH_FAILURES = 3;
export function parseGitwatch(state: unknown): NonNullable<Facts['github']> | undefined {
  const repos = Object.values(record(record(state).repos)).map(record);
  if (!repos.length) return undefined;
  const failing = repos.filter(r => typeof r.failures === 'number' && r.failures >= GITWATCH_FAILURES);
  const polls = repos.map(r => r.lastPoll).filter((t): t is number => typeof t === 'number');
  const error = failing.map(r => r.lastError).find((e): e is string => typeof e === 'string');
  return { down: failing.length > 0 && failing.length * 2 >= repos.length, ...polls.length ? { since: Math.max(...polls) } : {}, failing: failing.length, repos: repos.length, ...error ? { error } : {} };
}

// ---- machine load ----

export function loadFrom(now: MachineNow | undefined): Load | undefined {
  if (!now) return undefined;
  return { t: now.t, cpu: now.cpu, memUsedPct: now.memTotalMb > 0 ? now.memUsedMb / now.memTotalMb * 100 : 0,
    owners: now.owners.slice(0, 2).map(o => ({ name: `${o.group}${o.detail ? ` ${o.detail}` : ''}`.slice(0, 40), cpuPct: o.cpuPct, rssMb: o.rssMb })) };
}

// ---- the real sources ----

export interface Ran { code: number | null; stdout: string }
export interface SourceDeps {
  agentDir: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Runs a program, never rejects: a missing program or a timeout is a non-zero code. */
  run?: (file: string, args: string[], timeoutMs: number) => Promise<Ran>;
  read?: (file: string) => string;
  hasDocker?: () => boolean;
  disk?: (drive: string) => { free: number; total: number };
  machine?: () => MachineNow | undefined;
  work?: () => { agents: number; shells: number };
}

export const run = (file: string, args: string[], timeoutMs: number): Promise<Ran> =>
  new Promise(resolve => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 2_000_000 }, (error, stdout) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? '') });
      });
    } catch { resolve({ code: 1, stdout: '' }); }
  });

const onPath = (name: string) => (process.env.PATH ?? '').split(delimiter).some(dir => dir && (existsSync(join(dir, `${name}.exe`)) || existsSync(join(dir, name))));
const REBOOT_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
];

export function realSources(deps: SourceDeps): Sources {
  const platform = deps.platform ?? process.platform, now = deps.now ?? Date.now, exec = deps.run ?? run;
  const read = deps.read ?? ((file: string) => readFileSync(file, 'utf8'));
  const windows = platform === 'win32';
  const drive = windows ? `${process.env.SystemDrive ?? 'C:'}\\` : '/';
  const sources: Sources = {
    disk: { ttlMs: MIN, timeoutMs: 2_000, read: () => { const s = (deps.disk ?? ((d: string) => { const f = statfsSync(d); return { free: f.bavail * f.bsize, total: f.blocks * f.bsize }; }))(drive); return { free: s.free, total: s.total }; } },
    memory: { ttlMs: MIN, timeoutMs: 1_000, read: () => ({ free: freemem(), total: totalmem() }) },
    quota: { ttlMs: MIN, timeoutMs: 2_000, read: () => parseQuota(JSON.parse(read(join(deps.agentDir, 'provider-failover-state.json'))), now()) },
    github: { ttlMs: 30_000, timeoutMs: 2_000, read: () => parseGitwatch(JSON.parse(read(join(deps.agentDir, 'gitwatch', 'state.json')))) },
  };
  if (deps.machine) sources.load = { ttlMs: 5_000, timeoutMs: 500, read: () => loadFrom(deps.machine!()) };
  if (deps.work) sources.work = { ttlMs: 5_000, timeoutMs: 500, read: () => deps.work!() };
  if (windows) {
    sources.reboots = { ttlMs: 5 * MIN, timeoutMs: 20_000, read: async () => {
      const ran = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(EVENT_SCRIPT)], 15_000);
      if (ran.code !== 0) throw new Error(`event log read failed (code ${ran.code})`);
      return parseReboots(ran.stdout.trim(), now());
    } };
    sources.bootAt = { ttlMs: 5 * MIN, timeoutMs: 500, read: () => now() - uptime() * 1000 };
    sources.rebootPending = { ttlMs: 5 * MIN, timeoutMs: 6_000, read: async () => (await Promise.all(REBOOT_KEYS.map(key => exec('reg.exe', ['query', key], 3_000)))).some(r => r.code === 0) };
    sources.docker = { ttlMs: MIN, timeoutMs: 5_000, read: async () => (deps.hasDocker ?? (() => onPath('docker')))() ? ((await exec('docker', ['info', '--format', '{{.ServerVersion}}'], 3_000)).code === 0 ? 'up' : 'down') : 'absent' };
  }
  return sources;
}
