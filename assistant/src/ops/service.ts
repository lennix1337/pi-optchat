import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, type Config } from '../main.ts';
import { checkConfigPrivacy } from '../store/privacy.ts';

/**
 * Local operation of the manual assistant server: start, stop and health for one config file. The scripts keep an
 * ownership record (pid plus the operating system's start time for that pid) beside the private config, and only ever
 * signal a process whose current start time still matches it, so a reused pid or a foreign listener is never touched.
 * Nothing here installs a service; health makes one authenticated loopback read and no model or paid calls.
 */
export type OwnershipRecord = { version: 1; pid: number; processStartTime: string; endpoint: string; configPath: string; startedAt: string };
export type ServicePaths = { config: string; record: string; lock: string; stopFile: string; log: string };
export type ApiProbe = 'ok' | 'unauthorized' | 'error' | 'unreachable';
export type StartResult = { result: 'started' | 'already_running'; pid: number; endpoint: string; staleRecordRemoved?: boolean };
export type StopResult = { result: 'stopped'; pid: number; mode: 'graceful' | 'forced' } | { result: 'not_running'; portInUse: boolean } | { result: 'stale_record_removed'; pid: number };
export type HealthReport = {
  state: 'healthy' | 'unhealthy' | 'stopped' | 'stale_record' | 'foreign_listener'; endpoint: string; pid?: number; api?: ApiProbe;
  workingSetBytes?: number; dataBytes: number; logBytes: number; detail: string;
};

const PWSH = 'C:/Program Files/PowerShell/7/pwsh.exe';
const LOG_ROTATE_BYTES = 1024 * 1024;
const main = fileURLToPath(new URL('../main.ts', import.meta.url));

export class OpsError extends Error {
  readonly detail: string;
  constructor(code: string, detail = '') { super(code); this.name = 'OpsError'; this.detail = detail; }
}

export function servicePaths(configPath: string): ServicePaths {
  if (typeof configPath !== 'string' || !isAbsolute(configPath)) throw new OpsError('invalid_config_path');
  const dir = dirname(configPath);
  return { config: configPath, record: join(dir, 'assistant-service.json'), lock: join(dir, 'assistant-service.lock'),
    stopFile: join(dir, 'assistant-service.stop'), log: join(dir, 'assistant-service.log') };
}
/** Same privacy precheck and parser as the server itself; the token stays in memory and is never printed. */
export function loadConfig(configPath: string): Config {
  try { checkConfigPrivacy(configPath); } catch { throw new OpsError('config_not_private', 'use a private directory and file; permissions are not repaired'); }
  try { return readConfig(configPath); } catch { throw new OpsError('config_invalid', 'see node assistant/src/main.ts --help'); }
}
const portOf = (endpoint: string) => Number(endpoint.slice(endpoint.lastIndexOf(':') + 1));

/** The operating system's start time for `pid` (and its working set), or null when no such process exists. */
export function processInfo(pid: number): { startTime: string; workingSetBytes: number } | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const script = "$p=Get-Process -Id ([int]$env:OPS_PID) -ErrorAction SilentlyContinue; if($p){[Console]::Out.Write(\"$($p.StartTime.ToUniversalTime().Ticks) $($p.WorkingSet64)\")}";
    const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, OPS_PID: String(pid) }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r.error || r.status !== 0) throw new OpsError('process_inspection_failed');
    const match = /^(\d+) (\d+)$/.exec(r.stdout.trim());
    return match ? { startTime: match[1], workingSetBytes: Number(match[2]) } : null;
  }
  const r = spawnSync('ps', ['-o', 'lstart=,rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 });
  if (r.error) throw new OpsError('process_inspection_failed');
  const line = r.stdout.trim();
  if (r.status !== 0 || !line) return null;
  const parts = line.split(/\s+/);
  return { startTime: parts.slice(0, -1).join(' '), workingSetBytes: Number(parts.at(-1)) * 1024 };
}
/** True only while the recorded pid still belongs to the process the start script launched. */
export function owns(record: { pid: number; processStartTime: string }): boolean {
  return processInfo(record.pid)?.startTime === record.processStartTime;
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function portInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(port, '127.0.0.1');
    socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
/** One authenticated metadata read; any HTTP answer other than 200 is a definite verdict, not "starting". */
export async function probeApi(endpoint: string, token: string): Promise<ApiProbe> {
  try {
    const response = await fetch(`${endpoint}/v1/tasks?limit=1`, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.status === 200 ? 'ok' : response.status === 401 ? 'unauthorized' : 'error';
  } catch { return 'unreachable'; }
}

function readRecord(path: string): OwnershipRecord | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as OwnershipRecord;
    if (Number.isSafeInteger(value.pid) && typeof value.processStartTime === 'string') return value;
  } catch { /* An unreadable record proves no ownership: it is treated as stale below. */ }
  return { version: 1, pid: 0, processStartTime: '', endpoint: '', configPath: '', startedAt: '' };
}

/** Serializes start and stop for one config. A lock left by a dead script is broken; a live holder means busy. */
async function withLock<T>(paths: ServicePaths, fn: () => Promise<T>): Promise<T> {
  const self = processInfo(process.pid);
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(paths.lock, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, processStartTime: self?.startTime ?? '' })); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw new OpsError('service_busy', 'another start or stop for this config is in progress');
      let holder: { pid: number; processStartTime: string };
      // An empty or partial lock is a holder still writing it: busy, not stale.
      try { holder = JSON.parse(readFileSync(paths.lock, 'utf8')); }
      catch { throw new OpsError('service_busy', `another start or stop is writing ${paths.lock}; if none is running, remove that file`); }
      if (alive(holder.pid) && owns(holder)) throw new OpsError('service_busy', 'another start or stop for this config is in progress');
      rmSync(paths.lock, { force: true });
    }
  }
  try { return await fn(); } finally { rmSync(paths.lock, { force: true }); }
}

function rotateLog(log: string): void {
  if (existsSync(log) && statSync(log).size > LOG_ROTATE_BYTES) renameSync(log, `${log}.1`);
}
export function logTail(log: string, token: string, lines = 20): string {
  if (!existsSync(log)) return '';
  return readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n').replaceAll(token, '[redacted]');
}

export async function startService(options: { configPath: string; web?: boolean; readyTimeoutMs?: number }): Promise<StartResult> {
  const paths = servicePaths(options.configPath);
  const config = loadConfig(paths.config);
  return withLock(paths, async () => {
    const record = readRecord(paths.record);
    let staleRecordRemoved = false;
    if (record) {
      if (owns(record)) return { result: 'already_running', pid: record.pid, endpoint: record.endpoint };
      rmSync(paths.record, { force: true });
      staleRecordRemoved = true;
    }
    if (await portInUse(portOf(config.endpoint))) throw new OpsError('port_in_use', 'a process this tool did not start listens on the configured port; it was not touched');
    rotateLog(paths.log);
    rmSync(paths.stopFile, { force: true });
    const log = openSync(paths.log, 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [main, '--config', paths.config, ...(options.web ? ['--web'] : [])], {
        detached: true, stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, OPTCHAT_ASSISTANT_STOP_FILE: paths.stopFile },
      });
    } finally { closeSync(log); }
    let exited = false;
    child.once('exit', () => { exited = true; });
    child.once('error', () => { exited = true; });
    const pid = child.pid ?? 0;
    const info = processInfo(pid);
    if (!info) throw new OpsError('start_failed', logTail(paths.log, config.token));
    const owned: OwnershipRecord = { version: 1, pid, processStartTime: info.startTime, endpoint: config.endpoint, configPath: paths.config, startedAt: new Date().toISOString() };
    writeFileSync(paths.record, JSON.stringify(owned), { mode: 0o600 });
    const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
    let probe: ApiProbe = 'unreachable';
    while (!exited && Date.now() < deadline) {
      probe = await probeApi(config.endpoint, config.token);
      if (probe !== 'unreachable') break;
      await sleep(150);
    }
    if (probe === 'ok') { child.unref(); return { result: 'started', pid, endpoint: config.endpoint, ...(staleRecordRemoved ? { staleRecordRemoved } : {}) }; }
    if (!exited && owns(owned)) { process.kill(pid); await waitForExit(pid, 5000); }
    rmSync(paths.record, { force: true });
    child.unref();
    throw new OpsError(exited ? 'start_failed' : 'start_unhealthy', logTail(paths.log, config.token));
  });
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (!alive(pid)) return true; await sleep(100); }
  return !alive(pid);
}

export async function stopService(options: { configPath: string; graceMs?: number }): Promise<StopResult> {
  const paths = servicePaths(options.configPath);
  const config = loadConfig(paths.config);
  return withLock(paths, async () => {
    const record = readRecord(paths.record);
    if (!record) return { result: 'not_running', portInUse: await portInUse(portOf(config.endpoint)) };
    if (!owns(record)) { rmSync(paths.record, { force: true }); return { result: 'stale_record_removed', pid: record.pid }; }
    writeFileSync(paths.stopFile, '', { mode: 0o600 });
    try {
      let mode: 'graceful' | 'forced' = 'graceful';
      if (!await waitForExit(record.pid, options.graceMs ?? 10_000)) {
        // Re-check right before signalling: the pid must still be the process the start script launched.
        if (owns(record)) process.kill(record.pid);
        mode = 'forced';
        if (!await waitForExit(record.pid, 5000)) throw new OpsError('stop_failed', 'the service did not exit');
      }
      rmSync(paths.record, { force: true });
      return { result: 'stopped', pid: record.pid, mode };
    } finally { rmSync(paths.stopFile, { force: true }); }
  });
}

function bytesOf(paths: string[]): number {
  return paths.reduce((sum, path) => sum + (existsSync(path) ? statSync(path).size : 0), 0);
}

export async function serviceHealth(options: { configPath: string }): Promise<HealthReport> {
  const paths = servicePaths(options.configPath);
  const config = loadConfig(paths.config);
  const dataDir = dirname(config.databasePath);
  const base = { endpoint: config.endpoint, dataBytes: bytesOf(readdirSync(dataDir).filter(n => /\.(sqlite|db)(-wal|-shm|-journal)?$/.test(n)).map(n => join(dataDir, n))), logBytes: bytesOf([paths.log, `${paths.log}.1`]) };
  const record = readRecord(paths.record);
  if (!record) {
    return await portInUse(portOf(config.endpoint))
      ? { ...base, state: 'foreign_listener', detail: 'no ownership record, but another process listens on the configured port' }
      : { ...base, state: 'stopped', detail: 'no ownership record and the port is free' };
  }
  const info = processInfo(record.pid);
  if (info?.startTime !== record.processStartTime) return { ...base, state: 'stale_record', pid: record.pid, detail: 'the recorded process is gone or its pid was reused; stop removes the record without signalling' };
  const api = await probeApi(config.endpoint, config.token);
  return { ...base, state: api === 'ok' ? 'healthy' : 'unhealthy', pid: record.pid, api, workingSetBytes: info.workingSetBytes,
    detail: api === 'ok' ? 'authenticated loopback read succeeded' : `owned process is running but the API answered ${api}` };
}
