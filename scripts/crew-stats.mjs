// Measures the manager-mode targets from a profile's usage.jsonl: calls, cost and context per call by role and
// model, over a window. Read-only; prints one JSON object.
//
// usage: node scripts/crew-stats.mjs <profileDir> [sinceISO] [untilISO]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: crew-stats.mjs <profileDir> [sinceISO] [untilISO]';

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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.some(a => a === '--help' || a === '-h')) { console.log(USAGE); process.exit(0); }
  if (!args[0]) { console.error(USAGE); process.exit(2); }
  const lines = readFileSync(join(args[0], 'usage.jsonl'), 'utf8').split('\n').filter(Boolean);
  const since = args[1] ? Date.parse(args[1]) : Date.now() - 7 * 86_400_000;
  const until = args[2] ? Date.parse(args[2]) : Infinity;
  console.log(JSON.stringify(crewStats(lines, since, until), null, 2));
}
