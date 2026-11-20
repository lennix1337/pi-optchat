#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tallySession } from '../src/machine-turn-share.ts';

let hours = 24, cut;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i], value = process.argv[++i];
  if (arg === '--hours' && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0) hours = Number(value);
  else if (arg === '--since' && value && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(value) && Number.isFinite(Date.parse(value))) cut = Date.parse(value);
  else throw new Error(`Invalid argument: ${arg} ${value ?? ''}. Usage: node scripts/machine-turn-share.mjs [--hours N] [--since ISO]`);
}
const end = Date.now(), start = end - hours * 3600000;
const root = join(homedir(), '.pi', 'agent', 'sessions');
function* sessionFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}
const models = new Map(), before = { total: 0, machine: 0 }, after = { total: 0, machine: 0 };
for (const file of sessionFiles(root)) {
  let tally;
  try { tally = tallySession(readFileSync(file, 'utf8'), start, cut, end); }
  catch (error) { throw new Error(`Failed to read session ${file}`, { cause: error }); }
  for (const [model, counts] of tally.models) {
    const total = models.get(model) ?? { human: 0, machine: 0, heartbeat: 0, unknown: 0 };
    for (const key of Object.keys(total)) total[key] += counts[key];
    models.set(model, total);
  }
  for (const [to, from] of [[before, tally.opusBefore], [after, tally.opusAfter]]) {
    to.total += from.total; to.machine += from.machine;
  }
}
console.log(`Window: ${new Date(start).toISOString()} to ${new Date(end).toISOString()} (assistant messages; nearest preceding trigger)`);
console.log('Model\thuman\tmachine\theartbeat\tunknown\ttotal');
let opus = { total: 0, machine: 0 };
for (const [model, counts] of [...models].sort(([a], [b]) => a.localeCompare(b))) {
  const total = counts.human + counts.machine + counts.heartbeat + counts.unknown;
  console.log(`${model}\t${counts.human}\t${counts.machine}\t${counts.heartbeat}\t${counts.unknown}\t${total}`);
  if (model.startsWith('claude-opus')) { opus.total += total; opus.machine += counts.machine; }
}
const share = ({ machine, total }) => `${machine}/${total} (${total ? (100 * machine / total).toFixed(1) + '%' : 'n/a'})`;
console.log(`Opus machine share: ${share(opus)}; ${cut === undefined ? 'before/after: specify --since ISO' : `before ${new Date(cut).toISOString()}: ${share(before)}; after: ${share(after)}`}`);
