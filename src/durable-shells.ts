import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getShellConfig } from '@earendil-works/pi-coding-agent';
import { reapShellTree } from './shell-reaper.ts';
import type { ShellNotify } from './settings.ts';

/**
 * A durable shell runs detached from Pi: its output goes to a file in the profile and the shell writes its own exit code
 * when it ends. A /reload hands it over as any shell; a crash, a restart or Pi quitting leaves it running, and the next
 * OptChat that opens the profile follows it again and reports its end. Only a machine restart cuts it, reported as such.
 */
export interface DurableRecord { id: string; command: string; cwd: string; pid: number; started: number; notify: ShellNotify; alert?: string; deadline?: number }
const RECORD = 'job.json', LOG = 'output.log', EXIT = 'exit', REPORTED = 'reported';
const POLL_MS = 2_000, TAIL_BYTES = 32_000, KEEP_MS = 7 * 86_400_000;

export const durablePaths = (root: string, id: string) => {
  const dir = join(root, id);
  return { dir, record: join(dir, RECORD), log: join(dir, LOG), exit: join(dir, EXIT), reported: join(dir, REPORTED) };
};

/** Starts `command` detached; the wrapper shell records the command's exit status, whatever the command does with its own shell. */
export function launchDurable(root: string, job: Omit<DurableRecord, 'pid'>): DurableRecord {
  const paths = durablePaths(root, job.id);
  mkdirSync(paths.dir, { recursive: true });
  const config = getShellConfig();
  writeFileSync(paths.log, '');
  // The shell redirects its own output: a detached Windows process loses handles inherited through stdio.
  const child = spawn(config.shell, ['-c', 'bash -c "$OPTCHAT_DURABLE_COMMAND" >> "$OPTCHAT_DURABLE_LOG" 2>&1 < /dev/null; printf %s $? > "$OPTCHAT_DURABLE_EXIT"'], {
    cwd: job.cwd, detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, OPTCHAT_DURABLE_COMMAND: job.command, OPTCHAT_DURABLE_LOG: paths.log, OPTCHAT_DURABLE_EXIT: paths.exit },
  });
  child.once('error', () => {});
  child.unref();
  if (!child.pid) throw new Error('durable shell did not start');
  const record = { ...job, pid: child.pid };
  writeFileSync(paths.record, JSON.stringify(record));
  return record;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
const readExit = (file: string) => { try { const text = readFileSync(file, 'utf8').trim(); return text === '' ? undefined : Number(text); } catch { return undefined; } };

/** The log from `offset` on, and the new offset. */
function readFrom(file: string, offset: number): { chunk: Buffer; offset: number } {
  let size = 0;
  try { size = statSync(file).size; } catch { return { chunk: Buffer.alloc(0), offset }; }
  if (size <= offset) return { chunk: Buffer.alloc(0), offset: size };
  const fd = openSync(file, 'r');
  try { const chunk = Buffer.alloc(size - offset); readSync(fd, chunk, 0, chunk.length, offset); return { chunk, offset: size }; } finally { closeSync(fd); }
}
const tail = (file: string) => { try { const size = statSync(file).size; return readFrom(file, Math.max(0, size - TAIL_BYTES)).chunk.toString('utf8'); } catch { return ''; } };

export interface FollowOptions { feed?: (chunk: Buffer) => void; pollMs?: number }
/**
 * Follows a durable shell until its exit file appears or its process is gone; an abort (shell_stop, a timeout) kills its tree.
 * The end is marked reported here, so the next profile open does not report it again.
 */
export async function followDurable(root: string, record: DurableRecord, signal: AbortSignal, update: (output: string, log?: string) => void, options: FollowOptions = {}) {
  const paths = durablePaths(root, record.id);
  let offset = 0, stopping = false;
  const kill = () => { stopping = true; void reapShellTree(record.pid, getShellConfig().shell).catch(() => {}); };
  if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true });
  const timer = record.deadline === undefined ? undefined : setTimeout(kill, Math.max(0, record.deadline - Date.now()));
  try {
    for (;;) {
      const read = readFrom(paths.log, offset);
      if (read.chunk.length) { offset = read.offset; options.feed?.(read.chunk); update(tail(paths.log), paths.log); }
      const exitCode = readExit(paths.exit);
      if (exitCode !== undefined || !alive(record.pid)) {
        const code = exitCode ?? readExit(paths.exit);
        const lost = code === undefined && !stopping ? '\n[OptChat: the shell ended without recording an exit code: the machine restarted or something killed it. Work it committed is kept; rerun the rest.]' : '';
        writeFileSync(paths.reported, String(Date.now()));
        if (stopping) throw new Error('aborted');
        return { output: tail(paths.log) + lost, failed: code !== 0, exitCode: code, log: paths.log };
      }
      await new Promise(resolve => setTimeout(resolve, options.pollMs ?? POLL_MS));
    }
  } finally { clearTimeout(timer); signal.removeEventListener('abort', kill); }
}

/** Durable shells of the profile still to follow (no end reported yet); ended ones older than a week are deleted. */
export function pendingDurable(root: string, now = Date.now()): DurableRecord[] {
  if (!existsSync(root)) return [];
  const pending: DurableRecord[] = [];
  for (const id of readdirSync(root)) {
    const paths = durablePaths(root, id);
    try {
      if (existsSync(paths.reported)) { if (now - statSync(paths.reported).mtimeMs > KEEP_MS) rmSync(paths.dir, { recursive: true, force: true }); continue; }
      pending.push(JSON.parse(readFileSync(paths.record, 'utf8')) as DurableRecord);
    } catch { /* a half-written record: its launch failed before the shell started */ }
  }
  return pending.sort((a, b) => a.started - b.started);
}
