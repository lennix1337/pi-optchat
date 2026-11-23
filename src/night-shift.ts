import { join } from 'node:path';
import { record } from './cache.ts';
import { atomicWrite, readJsonOr } from './store.ts';

export interface NightShiftConfig {
  enabled: boolean;
  window: string;
  repos: string[];
  sentryProjects: string[];
  digestAt: string;
}

export interface NightShiftEntry {
  at: number;
  item: string;
  branch?: string;
  prUrl?: string;
  reason?: string;
}

export const NIGHT_SHIFT_LOG = 'night-shift.json';
const KEEP = 100;
const GRACE_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const DIGEST_LINES = 5;

export const DEFAULT_NIGHT_SHIFT: NightShiftConfig = {
  enabled: false,
  window: '01:00-06:00',
  repos: [],
  sentryProjects: [],
  digestAt: '08:30',
};

const TIME_RE = /^(\d{2}):(\d{2})$/;
const WINDOW_RE = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function parseClock(value: string): number | undefined {
  const m = TIME_RE.exec(value);
  if (!m) return undefined;
  const hh = Number(m[1]), mm = Number(m[2]);
  return hh <= 23 && mm <= 59 ? hh * 60 + mm : undefined;
}

function parseWindow(value: string): { start: number; end: number } | undefined {
  const m = WINDOW_RE.exec(value);
  if (!m) return undefined;
  const start = parseClock(`${m[1]}:${m[2]}`);
  const end = parseClock(`${m[3]}:${m[4]}`);
  if (start === undefined || end === undefined || start === end) return undefined;
  return { start, end };
}

function validRepo(repo: unknown): repo is string {
  return typeof repo === 'string' && REPO_RE.test(repo) && !repo.split('/').some(part => part === '.' || part === '..');
}

/** Why a config.json `nightShift` entry can't be used, or undefined if it can. */
export function invalidNightShift(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) return 'nightShift must be an object.';
  if (typeof value.enabled !== 'boolean') return 'nightShift.enabled must be true or false.';
  if (value.window !== undefined && (typeof value.window !== 'string' || !parseWindow(value.window))) {
    return 'nightShift.window must be "HH:MM-HH:MM" in 24h time with distinct start and end.';
  }
  if (value.digestAt !== undefined && (typeof value.digestAt !== 'string' || parseClock(value.digestAt) === undefined)) {
    return 'nightShift.digestAt must be "HH:MM" in 24h time.';
  }
  if (value.repos !== undefined && (!Array.isArray(value.repos) || !value.repos.every(validRepo))) {
    return 'nightShift.repos must be a list of "owner/repo" strings.';
  }
  if (value.sentryProjects !== undefined && (!Array.isArray(value.sentryProjects) || !value.sentryProjects.every(p => typeof p === 'string' && p.trim() !== ''))) {
    return 'nightShift.sentryProjects must be a list of non-empty strings.';
  }
  return undefined;
}

export function nightShiftConfig(config: { nightShift?: Partial<NightShiftConfig> }): NightShiftConfig {
  const raw = config.nightShift;
  if (!raw) return DEFAULT_NIGHT_SHIFT;
  return {
    enabled: raw.enabled ?? DEFAULT_NIGHT_SHIFT.enabled,
    window: raw.window ?? DEFAULT_NIGHT_SHIFT.window,
    repos: raw.repos ?? DEFAULT_NIGHT_SHIFT.repos,
    sentryProjects: raw.sentryProjects ?? DEFAULT_NIGHT_SHIFT.sentryProjects,
    digestAt: raw.digestAt ?? DEFAULT_NIGHT_SHIFT.digestAt,
  };
}

/** True when `now` (local time) falls inside `[start, end)` of `window`, supporting overnight spans. */
export function inNightShiftWindow(window: string, now = Date.now()): boolean {
  const parsed = parseWindow(window);
  if (!parsed) return false;
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  return parsed.start < parsed.end
    ? mins >= parsed.start && mins < parsed.end
    : mins >= parsed.start || mins < parsed.end;
}

/** Start and end timestamps (ms) of the most recent night-shift window at or before `now`. */
export function lastNightRange(window: string, now: number): { start: number; end: number } {
  const parsed = parseWindow(window) ?? { start: 60, end: 360 };
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  const mins = d.getHours() * 60 + d.getMinutes();
  const baseDay = mins >= parsed.start ? dayStart : dayStart - DAY_MS;
  const start = baseDay + parsed.start * 60_000;
  const durationMins = parsed.start < parsed.end
    ? parsed.end - parsed.start
    : (24 * 60 - parsed.start) + parsed.end;
  return { start, end: start + durationMins * 60_000 };
}

export const nightShiftLogPath = (dir: string) => join(dir, NIGHT_SHIFT_LOG);

export function readNightShiftLog(dir: string): NightShiftEntry[] {
  const raw = readJsonOr<unknown>(nightShiftLogPath(dir), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is NightShiftEntry =>
    record(e) && typeof e.at === 'number' && Number.isFinite(e.at) && typeof e.item === 'string' && e.item.trim() !== '');
}

export function recordNightShiftAttempt(dir: string, entry: Omit<NightShiftEntry, 'at'>, now = Date.now()): NightShiftEntry {
  const next: NightShiftEntry = {
    at: now,
    item: entry.item.trim(),
    ...(entry.branch?.trim() ? { branch: entry.branch.trim() } : {}),
    ...(entry.prUrl?.trim() ? { prUrl: entry.prUrl.trim() } : {}),
    ...(entry.reason?.trim() ? { reason: entry.reason.trim() } : {}),
  };
  const all = [...readNightShiftLog(dir), next].slice(-KEEP);
  atomicWrite(nightShiftLogPath(dir), JSON.stringify(all, null, 2));
  return next;
}

/** Prompt block injected into wakeText() only when nightShift is enabled and `now` is inside its window. */
export function nightShiftWakeNote(config: NightShiftConfig, logPath: string, now = Date.now()): string | undefined {
  if (!config.enabled || !inNightShiftWindow(config.window, now)) return undefined;
  const sources = [
    `GitHub open issues (via \`gh issue list --repo <owner/repo> --state open\`): ${config.repos.length ? config.repos.join(', ') : '(none configured)'}`,
    ...config.sentryProjects.length ? [`Sentry unresolved issues (projects: ${config.sentryProjects.join(', ')})`] : [],
  ];
  return [
    `[Night shift (${config.window})] Pick one open item from the configured sources below (skipping items already recorded in ${logPath}):`,
    ...sources.map(s => `- ${s}`),
    'Workflow for the picked item: work on a new branch or worktree, reproduce the issue with a failing test first, implement the fix, run the focused tests, and open the PR as a draft (`gh pr create --draft`; never merge or mark ready for review).',
    `Record every attempt in ${logPath} as a JSON array entry: {"at": <epoch_ms>, "item": "<source-id: title>", "branch": "<branch>", "prUrl": "<draft PR URL>"} on success, or with "reason": "<why it stopped>" if it stopped without a draft PR.`,
  ].join('\n');
}

const one = (s: string, max: number) => {
  const t = s.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** At most 5 lines summarizing last night's log: draft PRs ready for review and stopped items with reason. */
export function nightShiftDigest(entries: readonly NightShiftEntry[], config: NightShiftConfig, now: number): string[] {
  if (!config.enabled) return [];
  const { start, end } = lastNightRange(config.window, now);
  const cutoff = Math.min(now, end + GRACE_MS);
  const lastNight = entries.filter(e => e.at >= start && e.at <= cutoff);
  if (!lastNight.length) return [];

  const prs = lastNight.filter(e => e.prUrl);
  const stopped = lastNight.filter(e => !e.prUrl);
  const ordered = [...prs, ...stopped];
  const format = (e: NightShiftEntry) => e.prUrl
    ? `• 📝 Draft PR pronto: ${one(e.item, 80)}${e.branch ? ` (\`${one(e.branch, 40)}\`)` : ''} — ${e.prUrl}`
    : `• ⏸️ Parou: ${one(e.item, 80)} — ${one(e.reason ?? 'motivo não informado', 100)}`;

  if (ordered.length <= DIGEST_LINES) return ordered.map(format);
  const shown = ordered.slice(0, DIGEST_LINES - 1).map(format);
  const rest = ordered.length - (DIGEST_LINES - 1);
  return [...shown, `• … e mais ${rest} tentativa(s) (${prs.length} draft PR(s), ${stopped.length} pararam).`];
}
