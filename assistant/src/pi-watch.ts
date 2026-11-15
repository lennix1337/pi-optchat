import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The Pi session as a sense, read from the launcher's lifecycle log. On 15/11 the Pi died at 05:48 with an unhandled
 * error and stayed down 5h34 because every wake timer lives inside it; nothing outside the Pi noticed. This service
 * outlives the Pi, so it tells the operator on Slack when the launcher's last word is an abnormal exit and no new
 * launch followed. A normal quit (exit 0) is the operator closing it and stays silent.
 */
export const PI_LIFECYCLE_LOG = join(homedir(), '.pi', 'agent', 'pi-process-lifecycle.jsonl');
const GRACE_MS = 10 * 60_000;
const TICK_MS = 60_000;
const TAIL_BYTES = 64 * 1024;

export type PiOutage = { since: number; exitCode: number | null; signal: string | null };

type Record = { timestamp?: unknown; event?: unknown; exitCode?: unknown; signal?: unknown };

export function piDown(lines: readonly string[], now: number, graceMs: number = GRACE_MS): PiOutage | null {
  let last: { at: number; record: Record } | undefined;
  for (const line of lines) {
    let record: Record;
    try { record = JSON.parse(line) as Record; } catch { continue; }
    if (record.event !== 'launch' && record.event !== 'launcher_result') continue;
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;
    if (!last || at >= last.at) last = { at, record };
  }
  if (!last || last.record.event !== 'launcher_result' || now - last.at < graceMs) return null;
  const exitCode = typeof last.record.exitCode === 'number' ? last.record.exitCode : null;
  const signal = typeof last.record.signal === 'string' ? last.record.signal : null;
  if (exitCode === 0 && signal === null) return null;
  return { since: last.at, exitCode, signal };
}

/** The last lines of the log, without reading a file that grows to megabytes. */
export function readLifecycleTail(file: string = PI_LIFECYCLE_LOG): string[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally { closeSync(fd); }
}

const brasilia = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

export type PiWatchOptions = { read?: () => readonly string[]; send: (text: string) => Promise<unknown>; now?: () => number; graceMs?: number };

export class PiWatch {
  private readonly options: PiWatchOptions;
  private told = 0;
  private timer: NodeJS.Timeout | undefined;
  constructor(options: PiWatchOptions) { this.options = options; }

  async check(): Promise<void> {
    const down = piDown((this.options.read ?? (() => readLifecycleTail()))(), (this.options.now ?? Date.now)(), this.options.graceMs);
    if (!down) { this.told = 0; return; }
    if (this.told === down.since) return;
    const how = down.signal ? `sinal ${down.signal}` : `código ${down.exitCode}`;
    await this.options.send(`O Pi caiu às ${brasilia(down.since)} (${how}) e não voltou. Os wakes e as rotinas ficam parados até alguém reabrir a sessão.`);
    this.told = down.since;
  }

  start(onError: () => void): void {
    this.timer = setInterval(() => { this.check().catch(onError); }, TICK_MS);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
