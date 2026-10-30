import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { SettingsManager, createBashToolDefinition, createLocalBashOperations, getAgentDir, getShellConfig, type BashOperations, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Git Bash pipelines outlive Pi's bash timeout on Windows. Each stage is forked and then exec'd, so its
 * Windows parent is a process that already exited, and `taskkill /T` (what Pi runs) never reaches it:
 * a timed-out `grep -r ... | head` kept reading disks for over half an hour on 2026-10-29. MSYS still
 * knows which shell the stages belong to, so the kill here asks both Windows and MSYS before it strikes.
 */

export interface MsysProcess { pid: number; ppid: number; pgid: number; winpid: number }

/**
 * The Windows pids to kill for the shell started as `root`: its Windows descendants, the MSYS processes
 * running in them, and everything MSYS lists under those (by parent, or by a process group one of them leads).
 * A group led by a process outside the tree is not ours, so it is never taken whole.
 */
export function ownedWindowsPids(root: number, windowsParents: Map<number, number>, msys: MsysProcess[], self = process.pid): Set<number> {
  const owned = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of windowsParents) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); grew = true; }
  }
  const mine = new Set(msys.filter(p => owned.has(p.winpid)).map(p => p.pid));
  const groups = new Set(msys.filter(p => mine.has(p.pid) && p.pgid === p.pid).map(p => p.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of msys) if (!mine.has(p.pid) && (mine.has(p.ppid) || groups.has(p.pgid))) { mine.add(p.pid); grew = true; }
  }
  for (const p of msys) if (mine.has(p.pid)) owned.add(p.winpid);
  owned.delete(self);
  return owned;
}

const run = (file: string, args: string[]) => new Promise<string>(resolve =>
  execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (_error, stdout) => resolve(stdout ?? '')));

async function windowsParents(): Promise<Map<number, number>> {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']);
  const parents = new Map<number, number>();
  for (const m of out.matchAll(/^(\d+) (\d+)\s*$/gm)) parents.set(Number(m[1]), Number(m[2]));
  return parents;
}

/** MSYS's `ps` beside the shell: Git's `bin\bash.exe` wrapper keeps it in `usr\bin`. */
function msysPs(shell: string): string | undefined {
  return [join(dirname(shell), 'ps.exe'), join(dirname(shell), '..', 'usr', 'bin', 'ps.exe')].find(existsSync);
}

async function msysProcesses(shell: string): Promise<MsysProcess[]> {
  const ps = msysPs(shell);
  if (!ps) return [];
  // Columns: [status] PID PPID PGID WINPID ...
  return [...(await run(ps, [])).matchAll(/^\s*[A-Z]?\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/gm)]
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), winpid: Number(m[4]) }));
}

const taskkill = () => join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');

/** Kills the shell started as `root` with every process it left, then resolves. Both snapshots come before any kill, while the tree is whole. */
export async function reapShellTree(root: number, shell: string): Promise<void> {
  const [parents, msys] = await Promise.all([windowsParents(), msysProcesses(shell)]);
  const pids = [...ownedWindowsPids(root, parents, msys)];
  await run(taskkill(), ['/F', '/T', ...pids.flatMap(pid => ['/PID', String(pid)])]);
}

const EXIT_STDIO_GRACE_MS = 100;
/** Resolves with the exit code once the shell exits and its pipes fall quiet, as Pi does, so a descendant holding stdout cannot hang the call. */
function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let code: number | null = null, done = false, gone = false, grace: NodeJS.Timeout | undefined;
    const finish = (value: number | null) => {
      if (done) return;
      done = true; clearTimeout(grace);
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve(value);
    };
    const quiet = () => { clearTimeout(grace); grace = setTimeout(() => finish(code), EXIT_STDIO_GRACE_MS); };
    child.stdout?.on('data', () => { if (gone) quiet(); });
    child.stderr?.on('data', () => { if (gone) quiet(); });
    child.once('error', error => { if (!done) { done = true; clearTimeout(grace); reject(error); } });
    child.once('exit', value => { gone = true; code = value; quiet(); });
    child.once('close', value => finish(value));
  });
}

/** Pi's own timeout rules for its bash tool: seconds, finite, positive, within a Node timer. */
function timeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid timeout: must be a finite number of seconds');
  if (timeout * 1000 > 2_147_483_647) throw new Error('Invalid timeout: maximum is 2147483.647 seconds');
  return timeout * 1000;
}

/** Shells still running when Pi exits get what Pi gives its own: a detached `taskkill /T`, since nothing async runs at exit. */
const live = new Set<number>();
process.once('exit', () => {
  for (const pid of live) {
    try { spawn(taskkill(), ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', detached: true, windowsHide: true }).once('error', () => {}); } catch { /* best effort */ }
  }
});

/**
 * Pi's local bash backend with a kill that reaches Git Bash pipeline stages. Outside Windows it is Pi's own,
 * which already kills the POSIX process group.
 */
export function reapingBashOperations(shellPath?: string): BashOperations {
  if (process.platform !== 'win32') return createLocalBashOperations({ shellPath });
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const ms = timeoutMs(timeout);
      if (signal?.aborted) throw new Error('aborted');
      const config = getShellConfig(shellPath);
      try { await access(cwd, constants.F_OK); } catch { throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`); }
      if (signal?.aborted) throw new Error('aborted');
      const stdin = config.commandTransport === 'stdin';
      const child = spawn(config.shell, stdin ? config.args : [...config.args, command], {
        cwd, env: env ?? process.env, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      if (stdin) { child.stdin?.on('error', () => {}); child.stdin?.end(command); }
      const pid = child.pid;
      if (pid) live.add(pid);
      let reaping: Promise<void> | undefined, timedOut = false;
      const kill = () => { if (pid && !reaping) reaping = reapShellTree(pid, config.shell); };
      const timer = ms === undefined ? undefined : setTimeout(() => { timedOut = true; kill(); }, ms);
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      if (signal?.aborted) kill(); else signal?.addEventListener('abort', kill, { once: true });
      try {
        const code = await exited(child);
        await reaping;
        if (signal?.aborted) throw new Error('aborted');
        if (timedOut) throw new Error(`timeout:${timeout}`);
        const killedBy = child.signalCode;
        return { exitCode: code ?? (killedBy ? 128 + (osConstants.signals[killedBy] ?? 0) : 1) };
      } finally {
        if (pid) live.delete(pid);
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
      }
    },
  };
}

/** The `shellCommandPrefix` and `shellPath` Pi gives its own bash tool, read per call so a settings change applies. */
function shellSettings(cwd: string) {
  const settings = SettingsManager.create(cwd, getAgentDir());
  return { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() };
}
const reapingBash = (cwd: string) => {
  const { commandPrefix, shellPath } = shellSettings(cwd);
  return createBashToolDefinition(cwd, { commandPrefix, shellPath, operations: reapingBashOperations(shellPath) });
};

/** On Windows, Pi's bash tool and the user's `!` commands run with the reaping kill; elsewhere Pi's own already reaches the whole group. */
export function registerReapingBash(pi: ExtensionAPI) {
  if (process.platform !== 'win32') return;
  pi.registerTool({ ...reapingBash(process.cwd()), execute: (id, params, signal, onUpdate, ctx) => reapingBash(ctx.cwd).execute(id, params, signal, onUpdate, ctx) });
  pi.on('user_bash', (_event, ctx) => ({ operations: reapingBashOperations(shellSettings(ctx.cwd).shellPath) }));
}
