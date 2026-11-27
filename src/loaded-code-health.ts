import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { brasiliaDayTime } from './pc-health.ts';
import type { LocalProbe, ProbeResult } from './prod-health.ts';

export const LOADED_CODE_HEALTH_FILE = 'loaded-code-health.json';
/** When this copy of the extension was evaluated: a Pi reload evaluates it again, a git pull does not. */
export const LOADED_AT = Date.now();
export const LOADED_CODE_WAKE_NOTE = 'A local Pi package has a commit newer than the code this session loaded, so merged fixes are not live yet. Save a checkpoint and run self_reload (pre-authorized), then check the probe recovered. Do not restart the process.';

const git = promisify(execFile);
const gitOut = async (repo: string, args: string[]) => (await git('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000 })).stdout.trim();

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');

/** The local (path) packages of the Pi settings: the ones a git pull changes under a running session. */
export function localPackages(settingsFile = join(agentDir(), 'settings.json')): string[] {
  try {
    const packages = (JSON.parse(readFileSync(settingsFile, 'utf8')) as { packages?: unknown }).packages;
    return Array.isArray(packages) ? packages.filter((p): p is string => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))) : [];
  } catch { return []; }
}

/** Commit time in seconds of the newest commit that changes more than documentation (a reload loads nothing from *.md or docs/), or undefined when the folder is not a repository. */
export async function headTime(repo: string): Promise<number | undefined> {
  try {
    const seconds = Number(await gitOut(repo, ['log', '-1', '--format=%ct', '--', '.', ':(exclude)*.md', ':(exclude)docs']));
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch { return undefined; }
}

/** Branch checked out in a package, or undefined when it is detached or not a repository. */
export async function currentBranch(repo: string): Promise<string | undefined> {
  try {
    return await gitOut(repo, ['branch', '--show-current']) || undefined;
  } catch { return undefined; }
}

/** Flags a package whose HEAD is newer than the moment this session loaded its code: a merged fix that only a reload makes live. */
export function loadedCodeProbe(packages: () => string[] = localPackages, loadedAt = LOADED_AT, time: (repo: string) => number | undefined | Promise<number | undefined> = headTime, branch: (repo: string) => string | undefined | Promise<string | undefined> = currentBranch): LocalProbe {
  return {
    name: 'Código carregado no Pi',
    async check(): Promise<ProbeResult> {
      const stale: { name: string; at: number; branch: string | undefined }[] = [];
      for (const repo of packages()) {
        const at = await time(repo);
        if (at !== undefined && at * 1000 > loadedAt) stale.push({ name: basename(repo), at: at * 1000, branch: await branch(repo) });
      }
      if (!stale.length) return { ok: true, ms: 0, detail: `Pi carregou às ${brasiliaDayTime(loadedAt)}; o HEAD de todos os pacotes locais é anterior` };
      return { ok: false, ms: 0, problem: `código carregado desatualizado: ${stale.map(s => `${s.name} (commit ${brasiliaDayTime(s.at)}${s.branch && s.branch !== 'main' ? `, checkout no branch ${s.branch}: volte a main, não é merge` : ''})`).join(', ')}; o Pi carregou às ${brasiliaDayTime(loadedAt)} — falta recarregar` };
    },
  };
}
