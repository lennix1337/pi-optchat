import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { brasiliaDayTime } from './pc-health.ts';
import type { LocalProbe, ProbeResult } from './prod-health.ts';

export const LOADED_CODE_HEALTH_FILE = 'loaded-code-health.json';
/** When this copy of the extension was evaluated: a Pi reload evaluates it again, a git pull does not. */
export const LOADED_AT = Date.now();
export const LOADED_CODE_WAKE_NOTE = 'A local Pi package has a commit newer than the code this session loaded, so merged fixes are not live yet. Save a checkpoint and run self_reload (pre-authorized), then check the probe recovered. Do not restart the process.';

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');

/** The local (path) packages of the Pi settings: the ones a git pull changes under a running session. */
export function localPackages(settingsFile = join(agentDir(), 'settings.json')): string[] {
  try {
    const packages = (JSON.parse(readFileSync(settingsFile, 'utf8')) as { packages?: unknown }).packages;
    return Array.isArray(packages) ? packages.filter((p): p is string => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))) : [];
  } catch { return []; }
}

/** Commit time in seconds of the newest commit that changes more than documentation (a reload loads nothing from *.md or docs/), or undefined when the folder is not a repository. */
export function headTime(repo: string): number | undefined {
  try {
    const seconds = Number(execFileSync('git', ['-C', repo, 'log', '-1', '--format=%ct', '--', '.', ':(exclude)*.md', ':(exclude)docs'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch { return undefined; }
}

/** Flags a package whose HEAD is newer than the moment this session loaded its code: a merged fix that only a reload makes live. */
export function loadedCodeProbe(packages: () => string[] = localPackages, loadedAt = LOADED_AT, time: (repo: string) => number | undefined = headTime): LocalProbe {
  return {
    name: 'Código carregado no Pi',
    check(): ProbeResult {
      const stale = packages().flatMap(repo => { const at = time(repo); return at !== undefined && at * 1000 > loadedAt ? [{ name: basename(repo), at: at * 1000 }] : []; });
      if (!stale.length) return { ok: true, ms: 0, detail: 'o Pi carrega o HEAD de todos os pacotes locais' };
      return { ok: false, ms: 0, problem: `código carregado desatualizado: ${stale.map(s => `${s.name} (commit ${brasiliaDayTime(s.at)})`).join(', ')}; o Pi carregou às ${brasiliaDayTime(loadedAt)} — falta recarregar` };
    },
  };
}
