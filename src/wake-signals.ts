import { createHash } from 'node:crypto';
import { errorCategory } from './compactor-diagnostics.ts';
import { dueFindings, type DueItem, type DueState } from './commitment-due.ts';
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
  /** The profile's commitments: a due time that passes, and an item overdue for a day, are signals (see commitment-due.ts). Absent: none. */
  commitments?: readonly DueItem[];
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
      if (!line.trim() || /^-\s+nothing notable$/.test(line.trim())) continue;
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
export function lastRunsOf(runs: readonly Pick<RunInfo, 'id' | 'kind' | 'project' | 'started' | 'ended' | 'state' | 'patrol'>[], now: number): Record<string, { id: string; at: number }> {
  const last: Record<string, { id: string; at: number }> = {};
  for (const run of runs) {
    if (!run.kind || !run.project || run.patrol) continue;
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

export type TriageDecision = 'drop' | 'react';

export interface PreTriageInput {
  /** Current radar snapshot text, or undefined if no radar is configured. */
  radar?: string;
  /** Normalized radar digest from the previous tick/wake, if any. */
  previousRadarDigest?: string;
  /** Whether the work queue (`heartbeat-queue.md`) has an open `[ ]` item. */
  queued?: boolean;
  /** How the last turn ended, when it was not a normal stop. */
  lastStop?: string;
  /** Open commitments that might be due, overdue, or have a failed probe. */
  commitments?: readonly DueItem[];
  /** Previous commitment due/escalation tracking state. */
  dueState?: DueState;
  /** Number of currently running subagents. */
  runningAgents?: number;
  /** Number of currently running background shells. */
  runningShells?: number;
  /** Current time in ms (for commitment due checks). */
  now: number;
}

export interface PreTriageResult {
  decision: TriageDecision;
  /** Short reason for the wake log and diagnostics. */
  reason: string;
  /** Normalized radar digest when radar was readable, so callers can persist it. */
  radarDigest?: string;
}

const MIN_NOISE_FREE_GIB = 10;
const RADAR_INTRO = /^Read-only snapshot for choosing work\b/i;
const PROBES_OK = /^-\s*(\d+)\s+of\s+(\d+)\s+probes?\s+OK\b/i;
const DISK_FREE = /^-\s*\S+\s+([\d.,]+)\s*(GiB|TiB|MiB|KiB|B)\s+free\b/i;

/** True when every non-header line in a readable radar is non-actionable noise (healthy probes, plenty of disk, or `nothing notable`). */
export function isRadarNoiseOnly(radar: string): boolean {
  if (!radar || radar.startsWith(UNAVAILABLE)) return false;
  let sawContent = false;
  for (const raw of radar.split('\n')) {
    const line = raw.trim();
    if (!line || /^#/.test(line) || RADAR_INTRO.test(line)) continue;
    if (TRUNCATED.test(line)) return false;
    sawContent = true;
    if (/^-\s*nothing notable$/i.test(line) || /^\(none\)$/i.test(line)) continue;
    const probe = PROBES_OK.exec(line);
    if (probe && Number(probe[2]) > 0 && Number(probe[1]) === Number(probe[2])) continue;
    const disk = DISK_FREE.exec(line);
    if (disk) {
      const amount = Number(disk[1].replace(/,/g, '')), unit = disk[2];
      const gib = unit === 'TiB' ? amount * 1024 : unit === 'GiB' ? amount : 0;
      if (gib >= MIN_NOISE_FREE_GIB) continue;
    }
    return false;
  }
  return sawContent;
}

/** Normalized digest of a readable radar (volatile figures stripped); undefined when missing or unavailable. */
export function normalizedRadarDigest(radar: string | undefined): string | undefined {
  if (!radar || radar.startsWith(UNAVAILABLE)) return undefined;
  const lines = radar.split('\n').filter(line => !/^# Wake radar\b/.test(line)).map(steadyLine).filter(Boolean);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Deterministic zero-cost pre-triage before calling the cloud heartbeat model (`HEARTBEAT_PROMPT`).
 * Fails open (`react`) whenever anything is uncertain, missing, or actionable.
 */
export function preTriage(input: PreTriageInput): PreTriageResult {
  const digest = normalizedRadarDigest(input.radar);
  if (input.queued) return { decision: 'react', reason: 'queued work item', ...digest ? { radarDigest: digest } : {} };
  const stop = input.lastStop?.trim();
  if (stop && !/^(?:normally|stop)$/i.test(stop)) {
    return { decision: 'react', reason: `last turn stopped (${stop.slice(0, 60)})`, ...digest ? { radarDigest: digest } : {} };
  }
  if ((input.runningAgents ?? 0) > 0 || (input.runningShells ?? 0) > 0) {
    return { decision: 'react', reason: 'running agents or shells', ...digest ? { radarDigest: digest } : {} };
  }
  if (input.commitments?.length) {
    const due = dueFindings(input.commitments, input.dueState ?? { dueSeen: [], escalated: {} }, input.now);
    if (due.findings.length > 0) {
      return { decision: 'react', reason: `commitment: ${due.findings[0]!.line.slice(0, 60)}`, ...digest ? { radarDigest: digest } : {} };
    }
  }
  if (!input.radar || input.radar.startsWith(UNAVAILABLE) || digest === undefined) {
    return { decision: 'react', reason: input.radar ? 'radar unavailable (fail-open)' : 'no radar (fail-open)' };
  }
  if (isRadarNoiseOnly(input.radar)) {
    return { decision: 'drop', reason: 'radar noise only', radarDigest: digest };
  }
  if (input.previousRadarDigest !== undefined && digest === input.previousRadarDigest) {
    return { decision: 'drop', reason: 'nothing changed', radarDigest: digest };
  }
  return { decision: 'react', reason: input.previousRadarDigest === undefined ? 'initial radar has signals' : 'radar changed', radarDigest: digest };
}
