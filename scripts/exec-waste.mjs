// Ranks what the agent's tool calls waste, from the exec log (src/exec-log.ts). Read-only: prints one JSON object.
//
// Waste is a call whose class is not `ok` (refusal, bad exit code, timeout, error ...) and the retry that follows it:
// the same intent (tool + the command's first two words, or the path/action) run again within RETRY_WINDOW_MS.
// Cost is the call's own ms, so a timeout counts what it waited and a refusal costs about nothing but still counts.
//
// usage: node scripts/exec-waste.mjs [logDir] [sinceISO]   (default dir: the swlucas05 profile, default since: 7 days)
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RETRY_WINDOW_MS = 10 * 60_000;
const TOP = 8;

/** The part of a call that says what it tried to do, so a retry with a different flag or path still matches. */
export const intentOf = row => {
  const target = String(row.target ?? '').trim();
  const head = row.name === 'bash' ? target.replace(/^cd [^&;]+(&&|;)\s*/, '').split(/\s+/).slice(0, 2).join(' ') : target.slice(0, 60);
  return `${row.name} ${head}`.trim();
};

const rank = (map, limit = TOP) => [...map.entries()].sort((a, b) => b[1].calls - a[1].calls || b[1].ms - a[1].ms).slice(0, limit)
  .map(([key, v]) => ({ key, calls: v.calls, seconds: +(v.ms / 1000).toFixed(1), ...(v.sample ? { sample: v.sample } : {}) }));
const bump = (map, key, row) => {
  const v = map.get(key) ?? { calls: 0, ms: 0 }; v.calls++; v.ms += row.ms ?? 0;
  if (row.detail && !v.sample) v.sample = String(row.detail).slice(0, 160);
  map.set(key, v);
};

/** rows: parsed exec-log entries in any order. */
export function summarize(rows, sinceMs = 0) {
  const sorted = rows.filter(r => r && typeof r.at === 'string' && Date.parse(r.at) >= sinceMs && r.source !== 'background').sort((a, b) => a.at.localeCompare(b.at));
  const byClass = {}, byTool = new Map(), byIntent = new Map(), retries = new Map();
  const failedAt = new Map(); // intent -> time of its latest non-ok call
  let wasteMs = 0, totalMs = 0, retryCalls = 0, bad = 0;
  for (const row of sorted) {
    byClass[row.class] = (byClass[row.class] ?? 0) + 1;
    totalMs += row.ms ?? 0;
    const intent = intentOf(row), t = Date.parse(row.at);
    const tool = byTool.get(row.name) ?? { calls: 0, ms: 0, bad: 0 }; tool.calls++; tool.ms += row.ms ?? 0; byTool.set(row.name, tool);
    const prior = failedAt.get(intent);
    if (prior !== undefined && t - prior <= RETRY_WINDOW_MS) { retryCalls++; bump(retries, intent, row); wasteMs += row.ms ?? 0; }
    if (row.class !== 'ok') {
      bad++; tool.bad++; wasteMs += prior !== undefined && t - prior <= RETRY_WINDOW_MS ? 0 : row.ms ?? 0;
      bump(byIntent, `${row.class}: ${intent}`, row); failedAt.set(intent, t);
    } else failedAt.delete(intent);
  }
  const tools = [...byTool.entries()].map(([name, v]) => ({ name, calls: v.calls, bad: v.bad, badPct: +(100 * v.bad / v.calls).toFixed(1), seconds: +(v.ms / 1000).toFixed(1) }))
    .filter(v => v.bad).sort((a, b) => b.bad - a.bad).slice(0, TOP);
  return { calls: sorted.length, bad, badPct: sorted.length ? +(100 * bad / sorted.length).toFixed(1) : 0, retryCalls,
    totalSeconds: +(totalMs / 1000).toFixed(1), wasteSeconds: +(wasteMs / 1000).toFixed(1), byClass, tools,
    topFailures: rank(byIntent), topRetries: rank(retries) };
}

export function readRows(dir) {
  return ['exec-log.jsonl.1', 'exec-log.jsonl'].map(n => join(dir, n)).filter(existsSync)
    .flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2] || join(homedir(), '.optchat', 'profiles', 'swlucas05');
  const since = process.argv[3] ? Date.parse(process.argv[3]) : Date.now() - 7 * 86_400_000;
  if (Number.isNaN(since)) throw new Error('usage: exec-waste.mjs [logDir] [sinceISO]');
  console.log(JSON.stringify(summarize(readRows(dir), since), null, 1));
}
