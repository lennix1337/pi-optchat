#!/usr/bin/env node
// What each crew worker pays to build its prompt cache: per worker run (usage rows with role "subagent"), the first call's cacheWrite and
// cacheRead tokens, the run's total cacheWrite and its cost, then median / p90 over the runs. Read-only: streams usage.jsonl line by line.
//
//   node scripts/worker-cache-stats.mjs [usage.jsonl] [--since 2026-11-09] [--until 2026-11-11] [--provider anthropic] [--model sonnet] [--json] [--runs]
//
// --since/--until: inclusive UTC dates (YYYY-MM-DD) of each call. --provider/--model: case-insensitive regular expressions
// (provider default "^anthropic": other providers report no cache writes). The default file is the swlucas05 profile's usage.jsonl.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_FILE = join(homedir(), '.optchat', 'profiles', 'swlucas05', 'usage.jsonl');

export function parseArgs(argv) {
  const options = { file: DEFAULT_FILE, since: undefined, until: undefined, provider: '^anthropic', model: undefined, json: false, runs: false };
  const value = (name, index) => { const next = argv[index + 1]; if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`); return next; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--since' || arg === '--until' || arg === '--provider' || arg === '--model') { options[arg.slice(2)] = value(arg, i); i++; }
    else if (arg === '--json') options.json = true;
    else if (arg === '--runs') options.runs = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.file = arg;
  }
  for (const key of ['since', 'until']) if (options[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options[key])) throw new Error(`--${key} is a date YYYY-MM-DD, not "${options[key]}"`);
  return options;
}

/** The q-quantile (0..1) of numbers by nearest rank; undefined for none. */
export function quantile(values, q) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Folds usage rows (given in file, i.e. time, order) into one record per worker run: `add(row)` per row, then `runs()`. */
export function runFolder(options = {}) {
  const provider = options.provider ? new RegExp(options.provider, 'i') : undefined, model = options.model ? new RegExp(options.model, 'i') : undefined;
  const runs = new Map();
  const add = row => {
    if (row?.role !== 'subagent' || !row.runId || !row.usage || typeof row.date !== 'string') return;
    const day = row.date.slice(0, 10);
    if (options.since && day < options.since || options.until && day > options.until) return;
    if (provider && !provider.test(row.provider ?? '') || model && !model.test(row.model ?? '')) return;
    const usage = row.usage;
    let run = runs.get(row.runId);
    if (!run) {
      run = { runId: row.runId, model: row.model, provider: row.provider, date: row.date, calls: 0, firstWrite: Number(usage.cacheWrite) || 0, firstRead: Number(usage.cacheRead) || 0,
        firstInput: Number(usage.input) || 0, totalWrite: 0, totalWrite1h: 0, totalRead: 0, cost: 0, writeCost: 0 };
      runs.set(row.runId, run);
    }
    run.calls++;
    run.totalWrite += Number(usage.cacheWrite) || 0; run.totalWrite1h += Number(usage.cacheWrite1h) || 0; run.totalRead += Number(usage.cacheRead) || 0;
    run.cost += Number(usage.cost?.total) || 0; run.writeCost += Number(usage.cost?.cacheWrite) || 0;
  };
  return { add, runs: () => [...runs.values()] };
}
export function foldRuns(rows, options = {}) {
  const folder = runFolder(options);
  for (const row of rows) folder.add(row);
  return folder.runs();
}

export function summarize(runs) {
  const column = key => runs.map(run => run[key]);
  const stat = key => ({ median: quantile(column(key), 0.5), p90: quantile(column(key), 0.9), sum: column(key).reduce((a, b) => a + b, 0) });
  const warm = runs.filter(run => run.firstRead > 0).length;
  return {
    runs: runs.length, calls: runs.reduce((sum, run) => sum + run.calls, 0), firstCallWarm: warm,
    firstWrite: stat('firstWrite'), firstRead: stat('firstRead'), totalWrite: stat('totalWrite'), cost: stat('cost'), writeCost: stat('writeCost'),
    totalWrite1h: column('totalWrite1h').reduce((a, b) => a + b, 0),
  };
}

async function* usageRows(file) {
  // Cheap pre-filter: only lines of role subagent are parsed (the file is ~150 MB).
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"role":"subagent"')) continue;
    try { yield JSON.parse(line); } catch { /* a torn last line */ }
  }
}

const n = value => value === undefined ? '-' : Math.round(value).toLocaleString('en-US');
const usd = value => value === undefined ? '-' : `$${value.toFixed(3)}`;

export function render(summary, options) {
  const row = (label, s, f) => `  ${label.padEnd(26)} median ${f(s.median).padStart(10)}   p90 ${f(s.p90).padStart(10)}   sum ${f(s.sum).padStart(12)}`;
  return [
    `worker usage ${options.file}`,
    `range ${options.since ?? '(start)'}..${options.until ?? '(end)'}  provider /${options.provider ?? ''}/  model /${options.model ?? ''}/`,
    `runs ${summary.runs}  calls ${summary.calls}  first call already warm (cacheRead>0): ${summary.firstCallWarm}  cacheWrite 1h tokens: ${n(summary.totalWrite1h)}`,
    row('first-call cacheWrite tok', summary.firstWrite, n),
    row('first-call cacheRead tok', summary.firstRead, n),
    row('run total cacheWrite tok', summary.totalWrite, n),
    row('run cacheWrite cost', summary.writeCost, usd),
    row('run total cost', summary.cost, usd),
  ].join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const folder = runFolder(options);
    for await (const row of usageRows(options.file)) folder.add(row);
    const runs = folder.runs(), summary = summarize(runs);
    if (options.json) console.log(JSON.stringify({ options, summary, ...(options.runs ? { runs } : {}) }, null, 2));
    else {
      console.log(render(summary, options));
      if (options.runs) for (const run of runs) console.log(`  ${run.runId} ${run.date.slice(0, 16)} ${run.model} calls ${run.calls} firstWrite ${run.firstWrite} firstRead ${run.firstRead} totalWrite ${run.totalWrite} cost ${usd(run.cost)}`);
    }
  } catch (error) { console.error(String(error instanceof Error ? error.message : error)); process.exit(2); }
}
