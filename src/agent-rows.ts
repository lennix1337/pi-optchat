import { basename } from 'node:path';
import { isActiveRun, isRunning, type RunInfo } from './runs.ts';

/** Boilerplate every worker task starts with (the shared prefix workers get for prompt-cache reasons), then a "Goal:"-style tag. Display only. */
const BOILERPLATE = [
  /^\s*\[This run\]\s*/i,
  /^\s*You are an? [^.\n]*?\b(?:subagent|worker)\b[^.\n]*\.\s*/i,
  /^\s*Don'?t (?:write memory pages|run memo)\.?\s*/i,
  /^\s*(?:Goal|Context|Task|Objective|Contract)\s*:\s*/i,
];
const MIN_SENTENCE = 12;

/** The run's own description: the contract's "Goal:" line without its tag, else the first line that is not the shared brief prefix; empty when the task is only prefix. */
export function taskLine(task: string) {
  const all = task.split('\n').map(l => l.trim());
  const goal = all.findIndex(l => /^Goal\s*:/i.test(l));
  const goalText = goal < 0 ? '' : all[goal].replace(/^Goal\s*:\s*/i, '') || all.slice(goal + 1).find(Boolean) || '';
  let text = task;
  for (let pass = 0; pass < 8 && !goalText; pass++) {
    const stripped = BOILERPLATE.reduce((t, pattern) => t.replace(pattern, ''), text);
    if (stripped === text) break;
    text = stripped;
  }
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return goalText || lines[0] || '';
}

/** `taskLine`, cut to its first sentence. */
export function taskLabel(task: string) {
  let line = taskLine(task), end = 0;
  if (!line) return task.trim();
  for (const match of line.matchAll(/[.!?](?=\s|$)/g)) { end = match.index + 1; if (end >= MIN_SENTENCE) break; }
  if (end >= MIN_SENTENCE) line = line.slice(0, end);
  return line;
}

/** `pi-optchat` for `C:/projetos/pi-optchat/.worktrees/x` or `.../pi-optchat`: the project a worktree belongs to, not its branch name. */
export function projectOf(cwd: string) {
  const parts = cwd.split(/[\\/]+/).filter(Boolean), at = parts.lastIndexOf('.worktrees');
  return at > 0 ? parts[at - 1] : basename(cwd.replace(/[\\/]+$/, ''));
}
/** `harness·code`: a short tag for where the run works and what kind of worker it is. */
export function runTag(run: RunInfo) {
  const project = run.project ?? (run.source === 'pi-subagents' && run.agent ? run.agent : projectOf(run.cwd));
  return [project, run.kind].filter(Boolean).join('·');
}

/** `sonnet`, `haiku`, `opus`; any other model keeps its own name without the provider. */
export function shortModel(model: string) {
  const name = model.slice(model.indexOf('/') + 1).replace(/[\x00-\x20\x7f-\x9f]/g, '');
  return /^claude-(?:\d[\d.-]*-)?(opus|sonnet|haiku)/.exec(name)?.[1] ?? (name || 'unknown');
}
/** The model to show per run: nothing for the most common model among `runs`, else its short name (with thinking when that differs too). */
export function modelColumn(runs: readonly RunInfo[]) {
  const tally = (key: (r: RunInfo) => string) => {
    const counts = new Map<string, number>();
    for (const run of runs) counts.set(key(run), (counts.get(key(run)) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const common = tally(r => shortModel(r.model)), thinking = tally(r => r.thinking);
  return (run: RunInfo) => {
    const model = shortModel(run.model);
    if (model === common && run.thinking === thinking) return '';
    return run.thinking && run.thinking !== thinking ? `${model}(${run.thinking})` : model;
  };
}

/** 45s, 4m 05s, 38m, 3h 5m, 2d: a duration compact enough for a column. */
export function compact(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h${s % 3600 >= 60 ? ` ${Math.floor(s % 3600 / 60)}m` : ''}`;
  return `${Math.floor(s / 86_400)}d`;
}
/** 40s, 12m, 3h, 2d: how long ago, to the unit that matters. */
export function ago(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86_400)}d`;
}

/** `bash: npm test`, `read: src/x.ts`: a tool and its most telling argument. */
export function toolBrief(name: string, args: unknown) {
  const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const pick = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'action', 'task']
    .map(key => record[key]).find((v): v is string => typeof v === 'string' && v.trim() !== '')
    ?? Object.values(record).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return pick ? `${name}: ${pick.replace(/\s+/g, ' ').trim()}` : name;
}

const FAILED_RECENT_MS = 24 * 3_600_000;
/** 0 live, 1 failed in the last 24 h, 2 the rest: what decides where a run sits in the panel. */
function bucket(run: RunInfo, now: number) {
  if (isActiveRun(run)) return 0;
  return run.state === 'failed' && now - (run.ended ?? run.started) < FAILED_RECENT_MS ? 1 : 2;
}
const recency = (run: RunInfo) => isActiveRun(run) ? run.started : run.ended ?? run.started;

/**
 * The panel's order: live runs, then failures of the last 24 h, then everything finished, newest first.
 * A run's own runs stay right under it; a tree sits where its most urgent run does.
 */
export function panelOrder(runs: readonly RunInfo[], now = Date.now()): RunInfo[] {
  const ids = new Set(runs.map(r => r.id)), kids = new Map<string, RunInfo[]>();
  for (const run of runs) if (run.parentId && ids.has(run.parentId)) kids.set(run.parentId, [...kids.get(run.parentId) ?? [], run]);
  const order = (a: RunInfo, b: RunInfo) => bucket(a, now) - bucket(b, now) || recency(b) - recency(a) || a.id.localeCompare(b.id);
  // A tree sits where its most urgent run does, and by the newest run of that urgency.
  const subtree = (run: RunInfo, seen = new Set<string>()): RunInfo[] => seen.has(run.id) ? [] : (seen.add(run.id), [run, ...(kids.get(run.id) ?? []).flatMap(k => subtree(k, seen))]);
  const key = (run: RunInfo) => {
    const members = subtree(run), urgency = Math.min(...members.map(m => bucket(m, now)));
    return { urgency, recent: Math.max(...members.filter(m => bucket(m, now) === urgency).map(recency)) };
  };
  const treeOrder = (a: RunInfo, b: RunInfo) => {
    const x = key(a), y = key(b);
    return x.urgency - y.urgency || y.recent - x.recent || a.id.localeCompare(b.id);
  };
  const result: RunInfo[] = [], visited = new Set<string>();
  const visit = (run: RunInfo) => {
    if (visited.has(run.id)) return;
    visited.add(run.id); result.push(run);
    for (const child of [...kids.get(run.id) ?? []].sort(treeOrder)) visit(child);
  };
  const roots = runs.filter(r => !r.parentId || !ids.has(r.parentId)).sort(treeOrder);
  roots.forEach(visit);
  [...runs].sort(order).forEach(visit); // Malformed cycles stay visible.
  return result;
}

/** The header's counts by state: `1 running · 1 failed today · 355 done`. Zero counts are left out. */
export function stateCounts(runs: readonly RunInfo[], now = Date.now()) {
  const n = (test: (r: RunInfo) => boolean) => runs.filter(test).length;
  const parts: [number, string][] = [
    [n(isRunning), 'running'], [n(r => r.state === 'paused'), 'paused'],
    [n(r => r.state === 'failed' && bucket(r, now) === 1), 'failed today'], [n(r => r.state === 'completed'), 'done'],
    [n(r => r.state === 'failed' && bucket(r, now) === 2), 'older failed'], [n(r => r.state === 'stopped' || r.state === 'interrupted'), 'stopped'],
  ];
  const text = parts.filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(' · ');
  return text || 'no agents';
}
