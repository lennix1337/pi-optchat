import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const failure = 'Could not initialize the new private directory. Existing permissions were not changed.';
// Native System32 tools start in milliseconds; PowerShell 7 took 40 s once under a parallel test load and blocked the event loop.
const system32 = (tool: string) => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);
const run = (tool: string, args: string[]) => spawnSync(system32(tool), args, { timeout: 60_000, encoding: 'utf8', windowsHide: true });

let currentUserSid: string | undefined;
function currentSid(): string {
  if (currentUserSid) return currentUserSid;
  const result = run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const sid = result.status === 0 ? /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(result.stdout.trim())?.[1] : undefined;
  if (!sid) throw new Error(failure);
  return currentUserSid = sid;
}

/** Protect only a directory this call created; existing paths are left for the privacy precheck. */
export function createPrivateDirectory(path: string): void {
  if (!isAbsolute(path)) throw new TypeError('Private directory path must be absolute');
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  if (process.platform !== 'win32') return;
  // Protected DACL with full control for the current user, SYSTEM and Administrators only, inherited by children.
  const grants = [currentSid(), 'S-1-5-18', 'S-1-5-32-544'].map(sid => `*${sid}:(OI)(CI)F`);
  const result = run('icacls.exe', [path, '/inheritance:r', '/grant:r', ...grants]);
  if (result.error || result.status !== 0) throw new Error(failure);
}
