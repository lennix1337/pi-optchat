// Measures the manager-mode targets of a profile over a window, read-only, printing one JSON object:
//   - usage.jsonl: calls, cost and context per call by role and model (crewStats);
//   - heartbeat.json wakeLog/daily (plus an optional extra wake file): empty and quota-error wakes;
//   - runs/*.optchat.json and their Pi sessions: contract workers, tool calls, re-reads of files an earlier
//     worker of the same project already read, context per call, tell_parent/tell_peer;
//   - main/YYYY-MM-DD.jsonl memory logs: manager tells, spawns and mid-run worker messages.
// A source that is missing prints "unavailable", never 0.
//
// usage: node scripts/crew-stats.mjs <profileDir> [sinceISO] [untilISO] [--metrics] [--wakes <file>] [--compare <baseline.json>]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: crew-stats.mjs <profileDir> [sinceISO] [untilISO] [--metrics] [--wakes <file>] [--compare <baseline.json>]';
const UNAVAILABLE = 'unavailable';
const DAY_MS = 86_400_000;
const REREAD_WINDOW_MS = DAY_MS;
const QUOTA_ERROR = /usage limit|insufficient_credits|\b429\b|credit balance|rate.?limit|quota|billing/i;
const PROJECT_PREFIX = /^(?:.*?\/)?(?=(?:src|test|scripts|apps|packages)\/)/;

export function crewStats(lines, sinceMs = 0, untilMs = Infinity) {
  const groups = new Map();
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row.date);
    if (!(at >= sinceMs && at < untilMs)) continue;
    const key = `${row.role ?? '?'} ${row.model ?? '?'}`;
    const group = groups.get(key) ?? { role: row.role ?? '?', model: row.model ?? '?', calls: 0, cost: 0, tokens: 0 };
    group.calls++;
    group.cost += Number(row.usage?.cost?.total ?? 0);
    group.tokens += Number(row.usage?.totalTokens ?? 0);
    groups.set(key, group);
  }
  const rows = [...groups.values()]
    .map(g => ({ role: g.role, model: g.model, calls: g.calls, cost: Math.round(g.cost * 100) / 100, tokensPerCall: Math.round(g.tokens / g.calls) }))
    .sort((a, b) => b.cost - a.cost);
  const opus = rows.filter(r => r.role === 'main' && /opus/.test(r.model));
  const total = rows.reduce((sum, r) => sum + r.cost, 0);
  return {
    opusMain: { calls: opus.reduce((s, r) => s + r.calls, 0), cost: Math.round(opus.reduce((s, r) => s + r.cost, 0) * 100) / 100 },
    total: Math.round(total * 100) / 100,
    rows,
  };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function readLines(path) {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean); } catch { return undefined; }
}

function parseJson(line) {
  try { return JSON.parse(line); } catch { return undefined; }
}

const normalizePath = path => String(path).replace(/\\/g, '/').toLowerCase().replace(PROJECT_PREFIX, '');

function median(values) {
  if (!values.length) return UNAVAILABLE;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;

// One Pi session: tool-call counts, files read and the context each assistant call carried.
function readSession(sessionFile) {
  const lines = readLines(sessionFile);
  if (!lines) return undefined;
  const session = { toolCalls: 0, reads: 0, files: new Set(), tellParent: 0, tellPeer: 0, contexts: [] };
  for (const line of lines) {
    const message = parseJson(line)?.message;
    if (message?.role !== 'assistant') continue;
    const usage = message.usage;
    if (usage) session.contexts.push(Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0));
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type !== 'toolCall') continue;
      session.toolCalls++;
      if (part.name === 'tell_parent') session.tellParent++;
      else if (part.name === 'tell_peer') session.tellPeer++;
      else if (part.name === 'read') {
        session.reads++;
        const path = part.arguments?.path;
        if (typeof path === 'string' && path) session.files.add(normalizePath(path));
      }
    }
  }
  return session;
}

function workerMetrics(profileDir, sinceMs, untilMs) {
  const runsDir = join(profileDir, 'runs');
  if (!existsSync(runsDir)) return UNAVAILABLE;
  const runs = [];
  for (const name of readdirSync(runsDir)) {
    if (!name.endsWith('.optchat.json')) continue;
    const run = readJson(join(runsDir, name));
    if (!run?.kind || !(run.started < untilMs && run.started >= sinceMs - REREAD_WINDOW_MS)) continue;
    runs.push({ project: run.project, started: run.started, inWindow: run.started >= sinceMs, session: run.sessionFile ? readSession(run.sessionFile) : undefined });
  }
  runs.sort((a, b) => a.started - b.started);
  const inWindow = runs.filter(r => r.inWindow);
  const read = inWindow.filter(r => r.session);
  const reReadsByProject = {};
  let reReads = 0;
  for (const run of read) {
    if (!run.project) continue;
    const earlier = runs.filter(e => e !== run && e.session && e.project === run.project && e.started < run.started && run.started - e.started <= REREAD_WINDOW_MS);
    for (const file of run.session.files) {
      if (!earlier.some(e => e.session.files.has(file))) continue;
      reReads++;
      reReadsByProject[run.project] = (reReadsByProject[run.project] ?? 0) + 1;
    }
  }
  const contexts = read.flatMap(r => r.session.contexts);
  return {
    contractWorkers: inWindow.length,
    sessionsMissing: inWindow.length - read.length,
    toolCalls: read.reduce((s, r) => s + r.session.toolCalls, 0),
    reads: read.reduce((s, r) => s + r.session.reads, 0),
    reReads,
    reReadsByProject,
    tellParent: read.reduce((s, r) => s + r.session.tellParent, 0),
    tellPeer: read.reduce((s, r) => s + r.session.tellPeer, 0),
    contextPerCall: contexts.length ? round(contexts.reduce((s, c) => s + c, 0) / contexts.length) : UNAVAILABLE,
    firstCallContextMedian: median(read.filter(r => r.session.contexts.length).map(r => r.session.contexts[0])),
  };
}

function wakeMetrics(profileDir, sinceMs, untilMs, wakesFile) {
  const heartbeat = readJson(join(profileDir, 'heartbeat.json'));
  const extra = wakesFile ? readJson(resolve(profileDir, wakesFile)) : undefined;
  if (!heartbeat && !extra) return UNAVAILABLE;
  const byAt = new Map();
  for (const wake of [...(extra?.wakeLog ?? []), ...(heartbeat?.wakeLog ?? [])]) {
    if (typeof wake?.at === 'number' && wake.at >= sinceMs && wake.at < untilMs) byAt.set(wake.at, wake);
  }
  const wakes = [...byAt.values()];
  const done = wakes.filter(w => w.outcome === 'done');
  const errors = wakes.filter(w => w.outcome === 'error');
  const firstDay = Math.floor(sinceMs / DAY_MS) * DAY_MS;
  const days = Array.isArray(heartbeat?.daily)
    ? heartbeat.daily.filter(d => { const at = Date.parse(`${d.day}T00:00:00Z`); return at >= firstDay && at < untilMs; })
    : undefined;
  const sum = key => days.reduce((s, d) => s + Number(d[key] ?? 0), 0);
  return {
    total: wakes.length,
    done: done.length,
    empty: done.filter(w => !(w.commits?.length > 0)).length,
    errors: errors.length,
    quotaErrors: errors.filter(w => QUOTA_ERROR.test(String(w.reply ?? ''))).length,
    interrupted: wakes.filter(w => w.outcome === 'interrupted').length,
    daily: days ? { wakes: sum('wakes'), errors: sum('errors'), skippedQuota: sum('skippedQuota'), skippedIdle: sum('skippedIdle') } : UNAVAILABLE,
  };
}

function managerMetrics(profileDir, sinceMs, untilMs) {
  const mainDir = join(profileDir, 'main');
  if (!existsSync(mainDir)) return UNAVAILABLE;
  const metrics = { tells: 0, spawns: 0, workerMessages: 0 };
  for (const name of readdirSync(mainDir)) {
    const day = /^(\d{4}-\d\d-\d\d)\.jsonl$/.exec(name)?.[1];
    if (!day) continue;
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    if (!(dayStart - DAY_MS < untilMs && dayStart + 2 * DAY_MS > sinceMs)) continue;
    for (const line of readLines(join(mainDir, name)) ?? []) {
      const entry = parseJson(line);
      const at = Date.parse(entry?.date);
      if (!(at >= sinceMs && at < untilMs)) continue;
      const text = String(entry.text ?? '');
      if (entry.kind === 'tool' && text.startsWith('tell ')) metrics.tells++;
      else if (entry.kind === 'tool' && text.startsWith('spawn ')) metrics.spawns++;
      else if (entry.kind === 'work' && text.includes('Message from subagent (still running)')) metrics.workerMessages++;
    }
  }
  return metrics;
}

export function crewMetrics(profileDir, sinceMs = 0, untilMs = Infinity, options = {}) {
  const usage = readLines(join(profileDir, 'usage.jsonl'));
  return {
    ...(usage ? crewStats(usage, sinceMs, untilMs) : { opusMain: UNAVAILABLE, total: UNAVAILABLE, rows: UNAVAILABLE }),
    workers: workerMetrics(profileDir, sinceMs, untilMs),
    wakes: wakeMetrics(profileDir, sinceMs, untilMs, options.wakesFile),
    manager: managerMetrics(profileDir, sinceMs, untilMs),
  };
}

// Numeric leaves (and "unavailable") of a metrics object, keyed by dotted path; usage rows are keyed by role and model.
function flatten(value, prefix = '', out = {}) {
  if (typeof value === 'number' || value === UNAVAILABLE) out[prefix] = value;
  else if (Array.isArray(value)) {
    for (const item of value) if (item && typeof item.role === 'string') flatten({ ...item, role: undefined, model: undefined }, `${prefix}[${item.role} ${item.model}]`, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) if (child !== undefined) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

export function compareMetrics(current, baseline) {
  const now = flatten(current);
  const before = flatten(baseline);
  const rows = {};
  for (const key of new Set([...Object.keys(now), ...Object.keys(before)])) {
    const row = {};
    if (key in now) row.current = now[key];
    if (key in before) row.baseline = before[key];
    if (typeof row.current === 'number' && typeof row.baseline === 'number') row.delta = round(row.current - row.baseline, 4);
    rows[key.replace(/^\./, '')] = row;
  }
  return rows;
}

function parseArgs(argv) {
  const positional = [];
  const options = { metrics: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--metrics') options.metrics = true;
    else if (arg === '--wakes') options.wakes = argv[++i];
    else if (arg === '--compare') options.compare = argv[++i];
    else positional.push(arg);
  }
  return { positional, options };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) { console.log(USAGE); process.exit(0); }
  const [profileDir, sinceArg, untilArg] = positional;
  if (!profileDir || (process.argv.includes('--wakes') && !options.wakes) || (process.argv.includes('--compare') && !options.compare)) { console.error(USAGE); process.exit(2); }
  const since = sinceArg ? Date.parse(sinceArg) : Date.now() - 7 * DAY_MS;
  const until = untilArg ? Date.parse(untilArg) : Infinity;
  if (options.metrics || options.compare) {
    const metrics = crewMetrics(profileDir, since, until, { wakesFile: options.wakes });
    if (!options.compare) console.log(JSON.stringify(metrics, null, 2));
    else {
      const baseline = readJson(resolve(options.compare));
      if (!baseline) { console.error(`cannot read baseline ${options.compare}`); process.exit(2); }
      const compare = compareMetrics(metrics, baseline);
      console.log(JSON.stringify(options.metrics ? { metrics, compare } : { compare }, null, 2));
    }
  } else {
    const lines = readFileSync(join(profileDir, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean);
    console.log(JSON.stringify(crewStats(lines, since, until), null, 2));
  }
}
