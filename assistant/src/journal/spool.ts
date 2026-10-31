import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** The profile's spool is the single durable entry point for sensors that run outside the service. */
export function signalsDataHome(): string {
  return process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat');
}
export function spoolPath(profileId: string): string {
  if (typeof profileId !== 'string' || profileId.length > 128 || profileId.trim() !== profileId || profileId === '.' || profileId === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(profileId)) throw new TypeError('Invalid profile');
  return join(signalsDataHome(), 'profiles', profileId, 'signals', 'inbox.jsonl');
}
/** Creates the private spool directory and returns the file path. */
export function ensureSpool(profileId: string): string {
  const path = spoolPath(profileId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return path;
}
/** Outcomes travel on their own spool so a producer can record work without the service or a model. */
export function outcomeSpoolPath(profileId: string): string {
  return join(dirname(spoolPath(profileId)), 'outcomes.jsonl');
}
export function ensureOutcomeSpool(profileId: string): string {
  const path = outcomeSpoolPath(profileId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return path;
}

export type SpoolResult = { ingested: number; duplicates: number; invalid: number };
/** What a spool drains into: the journal service, or an adapter that records one outcome. */
export type SpoolIngest = { ingest(value: unknown): { duplicate?: boolean } };
export type SpoolPollerOptions = { path: string; service: SpoolIngest };

/**
 * Ingests one rotation of the spool. The file is renamed before it is read, so a writer that appends during the pass
 * creates a fresh inbox instead of losing or duplicating a line. A rotation left by a crashed pass is replayed on the
 * next poll: ingestion is idempotent by `dedupeKey`, and a stored signal without a decision is decided on replay.
 * A failing storage pass puts the unread lines back in the inbox.
 */
export class SpoolPoller {
  private readonly path: string;
  private readonly service: SpoolIngest;
  private timer: NodeJS.Timeout | undefined;
  constructor(options: SpoolPollerOptions) {
    this.path = options.path;
    this.service = options.service;
  }

  /** Rotations left behind by a crashed pass, oldest first. Their content is older than the current inbox. */
  private leftovers(): string[] {
    const prefix = `${basename(this.path)}.`, directory = dirname(this.path);
    try {
      return readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith('.processing')).sort()
        .map(name => join(directory, name));
    } catch { return []; }
  }

  poll(): SpoolResult {
    const result: SpoolResult = { ingested: 0, duplicates: 0, invalid: 0 };
    for (const leftover of this.leftovers()) this.drain(leftover, result);
    if (!existsSync(this.path)) return result;
    const processing = `${this.path}.${randomUUID()}.processing`;
    try { renameSync(this.path, processing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw error;
    }
    this.drain(processing, result);
    return result;
  }

  private drain(processing: string, result: SpoolResult): void {
    if (!existsSync(processing)) return;
    const lines = readFileSync(processing, 'utf8').split('\n');
    try {
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();
        if (!line) continue;
        let value: unknown;
        try { value = JSON.parse(line); }
        catch { result.invalid++; continue; }
        try {
          const ingested = this.service.ingest(value);
          if (ingested.duplicate) result.duplicates++; else result.ingested++;
        } catch (error) {
          if (error instanceof TypeError) { result.invalid++; continue; }
          // Do not lose observations when storage is temporarily unavailable: put unread lines back in order.
          const rest = lines.slice(index).join('\n');
          if (rest.trim()) appendFileSync(this.path, `${rest}\n`, { mode: 0o600 });
          throw error;
        }
      }
    } finally { rmSync(processing, { force: true }); }
  }

  start(intervalMs: number, onError: () => void): void {
    this.stop();
    this.timer = setInterval(() => { try { this.poll(); } catch { onError(); } }, intervalMs);
    this.timer.unref();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
}
