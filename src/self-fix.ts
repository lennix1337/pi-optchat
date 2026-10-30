import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { brasiliaTime } from './heartbeat.ts';
import type { Transition } from './prod-health.ts';
import { atomicWrite, readJsonOr } from './store.ts';

/**
 * Problems OptChat fixes by itself, without a model call or the operator: a probe may carry a remedy, run once when it
 * goes down. The alert says it was already handled; the recovery says it was solved alone. A remedy that already ran
 * recently and did not help is not run again: that alert asks for the operator instead. Only remedies the operator
 * already runs on a schedule belong here (no deploy, production write, spending or account change).
 */
export interface Remedy { label: string; run(): Promise<void> }
export interface Fix { probe: string; label: string; at: number; outcome: 'tried' | 'resolved' | 'failed'; error?: string; resolvedAt?: number }

export const FIXES_FILE = 'self-fixes.json';
/** A remedy that did not fix its probe within this window is not retried: the problem needs the operator. */
export const RETRY_AFTER_MS = 12 * 3_600_000;
const KEEP = 50;

export const readFixes = (dir: string): Fix[] => readJsonOr<Fix[]>(join(dir, FIXES_FILE), []);
const save = (dir: string, fixes: Fix[]) => atomicWrite(join(dir, FIXES_FILE), JSON.stringify(fixes.slice(-KEEP)));

/** Runs the remedy of every probe that just went down and marks recoveries; returns the transitions with what was done appended. */
export async function applyRemedies(transitions: Transition[], remedies: ReadonlyMap<string, Remedy>, dir: string, now: number): Promise<Transition[]> {
  if (!transitions.length) return transitions;
  const fixes = readFixes(dir), out: Transition[] = [];
  for (const t of transitions) {
    const open = fixes.findLast(f => f.probe === t.probe && f.outcome === 'tried');
    const note = t.kind === 'recovered' ? recovered(open, now) : await remedied(t.probe, remedies.get(t.probe), open, fixes, now);
    out.push(note ? { ...t, text: `${t.text} · ${note}` } : t);
  }
  save(dir, fixes);
  return out;
}

/** Closes the open fix of a recovered probe; returns the note for its message. */
function recovered(open: Fix | undefined, now: number): string | undefined {
  if (!open) return undefined;
  Object.assign(open, { outcome: 'resolved', resolvedAt: now });
  return `resolvido sozinho (${open.label})`;
}

/** Runs the remedy of a probe that went down, unless it ran recently without effect; returns the note for the alert. */
async function remedied(probe: string, remedy: Remedy | undefined, open: Fix | undefined, fixes: Fix[], now: number): Promise<string | undefined> {
  if (!remedy) return undefined;
  if (open && now - open.at < RETRY_AFTER_MS) return `já rodei ${open.label} às ${brasiliaTime(open.at)} e não resolveu: preciso de você`;
  const fix: Fix = { probe, label: remedy.label, at: now, outcome: 'tried' };
  fixes.push(fix);
  try { await remedy.run(); } catch (error) { Object.assign(fix, { outcome: 'failed', error: error instanceof Error ? error.message : String(error) }); }
  return fix.outcome === 'tried' ? `já rodei ${remedy.label} sozinho; aviso se não resolver` : `tentei ${remedy.label} e falhou (${fix.error}): preciso de você`;
}

/** The morning summary's "solved alone" lines: fixes of the last 24 hours, newest last. */
export function fixLines(fixes: readonly Fix[], now: number): string[] {
  const word = { tried: 'rodando, aguardando efeito', resolved: 'resolvido', failed: 'falhou' } as const;
  return fixes.filter(f => now - f.at < 86_400_000).map(f => `${f.probe}: ${f.label} às ${brasiliaTime(f.at)} · ${word[f.outcome]}${f.error ? ` (${f.error})` : ''}`);
}

/** Starts a Windows scheduled task the operator already runs (e.g. the daily maintenance) ahead of its schedule. */
export function scheduledTask(name: string, label: string): Remedy {
  return {
    label,
    run: () => new Promise<void>((resolve, reject) => {
      execFile('schtasks.exe', ['/run', '/tn', name], { timeout: 30_000, windowsHide: true }, (error, _stdout, stderr) =>
        error ? reject(new Error(String(stderr).trim() || error.message)) : resolve());
    }),
  };
}
