import { createHash } from 'node:crypto';
import { errorCategory } from './compactor-diagnostics.ts';
import { missionProjects, specialistOf } from './crew.ts';
import type { RunInfo } from './runs.ts';

/** What a wake triage reads, per tick, besides the radar: the profile's cadence and what the crew is doing. */
export interface Triage {
  /** A wake with no signal still starts every this many minutes, to build something new. */
  buildMinutes: number;
  /** A tagged mission whose project had no worker run for this long counts as stalled (default 24). */
  stallHours?: number;
  /** The crew's missions.md. */
  missions: string;
  /** project -> when its last worker run was last active (ms). */
  lastRuns: Record<string, number>;
  /** How the last turn ended, when it was not a normal stop. */
  lastStop?: string;
}
/** One project with something new, and the lines that say what. `lastRun` is the id of its newest worker run, set by whoever knows the runs. */
export interface Signal { project: string; lines: string[]; lastRun?: string }

export const GLOBAL = 'global';
/** The digest key of the last turn's error: its own, so recovering from it is not a change of the radar's global lines. */
const STOP_KEY = 'global:stop';
const DEFAULT_STALL_HOURS = 24;
const HOUR = 3_600_000;

/** What the radar prints on every read without new information: item ages, probe latency and rounds, free disk, quiet minutes. */
const RADAR_VOLATILE: [RegExp, string][] = [
  [/updated \d[\d.]*\s*[a-z]+ ago/gi, 'updated'],
  [/\(\d[\d.]*\s*[a-z]+ ago\)/gi, '(ago)'],
  [/\d[\d.]*\s*[a-z]+ ago/gi, 'ago'],
  [/slowest \d+ ms/g, 'slowest'],
  [/\b(p50|max) \d+ ms/g, '$1'],
  [/\d+ rounds in \d+ h/g, 'rounds'],
  [/\d+ slow or failed/g, 'slow'],
  [/no write for \d+ min/g, 'no write'],
  [/[\d.,]+\s*[KMGTP]i?B free(?: of [\d.,]+\s*[KMGTP]i?B)?/g, 'free'],
];
/** One radar line with the figures that change on every read replaced by a word, and its spaces collapsed. */
export const steadyLine = (line: string) => RADAR_VOLATILE.reduce((text, [pattern, word]) => text.replace(pattern, word), line).replace(/\s+/g, ' ').trim();

const UNAVAILABLE = 'Wake radar unavailable';
const TRUNCATED = /^\[radar (?:truncated|output cut) at \d+ chars\]$/;
/** `owner/repo` at the start of a bullet, as in `lennix1337/Genexus18MCP#959 title`. */
const OWNER_REPO = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)(?=[#\s:@]|$)/;
/** A bare repository name before ` @ branch` or a colon, as in `pi-optchat @ main:` and `dentai-mono: worktrees/...`. */
const BARE_REPO = /^([A-Za-z][\w.-]*)(?: @ |:\s)/;

/** The project a radar bullet is about: the repo it names, through `specialistOf`; `global` when it names none. */
function projectOfBullet(text: string): string {
  const repo = OWNER_REPO.exec(text)?.[2] ?? BARE_REPO.exec(text)?.[1];
  return (repo && specialistOf(`C:/projetos/${repo}`)) || GLOBAL;
}

/** The radar's lines by project, in order of first appearance. The section holding the truncation marker is dropped (it is incomplete,
 * and the part the radar cut off changes what it shows without anything having happened); so are the title and the lines before the first section. */
function radarLines(radar: string | undefined): Map<string, string[]> {
  const by = new Map<string, string[]>();
  if (!radar || radar.startsWith(UNAVAILABLE)) return by;
  const sections: string[][] = [];
  for (const line of radar.split('\n')) {
    if (/^##\s/.test(line)) sections.push([]);
    else sections.at(-1)?.push(line);
  }
  for (const section of sections) {
    if (section.some(line => TRUNCATED.test(line.trim()))) continue;
    let project = GLOBAL;
    for (const line of section) {
      if (!line.trim()) continue;
      // A bullet picks its project; its indented detail lines follow it; a line that is not a bullet is global.
      if (/^-\s/.test(line)) project = projectOfBullet(line.replace(/^-\s+/, ''));
      else if (!/^\s/.test(line)) project = GLOBAL;
      by.set(project, [...by.get(project) ?? [], line.trim()]);
    }
  }
  return by;
}

/** A non-quota error the last turn ended on; a quota error is the quota gate's business. */
const stopLine = (lastStop: string | undefined) => lastStop && /^error\b/i.test(lastStop) && errorCategory(lastStop) !== 'rate_or_usage_limit'
  ? `last turn ended on ${lastStop}` : undefined;

const sha = (lines: string[]) => createHash('sha256').update(lines.map(steadyLine).join('\n')).digest('hex');

/** project -> digest of its radar lines, volatile figures left out. The last turn's error, if any, is under `global:stop`. */
export function projectDigests(radar: string | undefined, lastStop?: string): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const [project, lines] of radarLines(radar)) digests[project] = sha(lines);
  const stop = stopLine(lastStop);
  if (stop) digests[STOP_KEY] = sha([stop]);
  return digests;
}

/** The open missions that are stalled now, as their text: tagged with a project that had no worker run for `stallHours`. */
export function stalledMissions({ missions, lastRuns, now, stallHours = DEFAULT_STALL_HOURS }:
  { missions: string; lastRuns: Record<string, number>; now: number; stallHours?: number }): string[] {
  return missionProjects(missions).flatMap(({ project, text }) => project && now - (lastRuns[project] ?? -Infinity) >= stallHours * HOUR ? [text] : []);
}

/** Projects with something new since `previous`: a digest that differs (a project with none before counts), a tagged mission that
 * has stalled since `stalled` was taken, and the last turn's error. Projects that disappeared signal nothing. */
export function signals({ radar, previous, missions, lastRuns, now, stallHours = DEFAULT_STALL_HOURS, stalled = [], lastStop }: {
  radar: string | undefined; previous: Record<string, string>; missions: string; lastRuns: Record<string, number>; now: number;
  stallHours?: number; /** The stalled missions of the last tick (see `stalledMissions`). */ stalled?: readonly string[]; lastStop?: string }): Signal[] {
  const found = new Map<string, string[]>();
  const add = (project: string, lines: string[]) => found.set(project, [...found.get(project) ?? [], ...lines]);
  for (const [project, lines] of radarLines(radar)) if (previous[project] !== sha(lines)) add(project, lines);
  const stop = stopLine(lastStop);
  if (stop && previous[STOP_KEY] !== sha([stop])) add(GLOBAL, [stop]);
  for (const text of stalledMissions({ missions, lastRuns, now, stallHours })) {
    if (stalled.includes(text)) continue;
    const project = missionProjects(missions).find(mission => mission.text === text)!.project!;
    const last = lastRuns[project];
    add(project, [`mission stalled: ${text} (${last === undefined ? `no ${project} worker run yet` : `no ${project} worker run for ${Math.round((now - last) / HOUR)} h`})`]);
  }
  return [...found].map(([project, lines]) => ({ project, lines }));
}

/** Per project, the newest contract worker run (kind and project set): its id and when it was last active; a run still going counts as now. */
export function lastRunsOf(runs: readonly Pick<RunInfo, 'id' | 'kind' | 'project' | 'started' | 'ended' | 'state'>[], now: number): Record<string, { id: string; at: number }> {
  const last: Record<string, { id: string; at: number }> = {};
  for (const run of runs) {
    if (!run.kind || !run.project) continue;
    const finished = run.state === 'completed' || run.state === 'failed' || run.state === 'stopped' || run.state === 'interrupted';
    const at = finished ? run.ended ?? run.started : now;
    if (!last[run.project] || at >= last[run.project].at) last[run.project] = { id: run.id, at };
  }
  return last;
}

/** Why a config.json `wakeTriage` entry can't be used, or undefined if it can (absent keeps every wake on the schedule). */
export function invalidTriage(value: unknown) {
  if (value === undefined) return undefined;
  const plan = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  return plan && positive(plan.buildMinutes) && (plan.stallHours === undefined || positive(plan.stallHours)) ? undefined
    : 'wakeTriage must be { "buildMinutes": minutes, "stallHours": hours (optional) }, each a positive number.';
}
