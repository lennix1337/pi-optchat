#!/usr/bin/env node
// Rate of one-message memory leaves that name ids (commitments, ops, hashes, message numbers) their own message lacks.
// Usage: node --experimental-transform-types scripts/foreign-id-rate.mjs [profileDir] [fromId] [splitId]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { foreignIds } from '../src/carried-ids.ts';

if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
  console.log('usage: foreign-id-rate.mjs [profileDir] [fromId] [splitId]  (run with node --experimental-transform-types)');
  process.exit(0);
}
const [d, f, split = ''] = process.argv.slice(2);
const dir = d || join(homedir(), '.optchat', 'profiles', 'swlucas05');
const from = f || '104200';
const date = new Date().toISOString().slice(0, 10);
const read = (sub) => readFileSync(join(dir, sub, `${date}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const msgs = new Map(read('main').map((m) => [m.i, m]));
const sources = new Map([...msgs].map(([i, m]) => [i, m.text]));
const kind = (i) => msgs.get(i)?.kind;
// Calls and results pair by position within a batch, as Memory.resultOf/callOf do.
const resultOf = (i) => { let first = i, last = i; while (kind(first - 1) === 'tool') first--; while (kind(last + 1) === 'tool') last++; const j = last + 1 + i - first; return kind(j) === 'echo' ? msgs.get(j) : undefined; };
const callOf = (i) => { let results = i; while (kind(results - 1) === 'echo') results--; let calls = results; while (kind(calls - 1) === 'tool') calls--; const j = calls + i - results; return j < results && kind(j) === 'tool' ? msgs.get(j) : undefined; };
// Same allowance as the compactor (compactor.ts `own`): the message's own id; a call also sees its result, a result its call's text and id.
const allowed = (i) => {
  const result = kind(i) === 'tool' ? resultOf(i) : undefined, call = kind(i) === 'echo' ? callOf(i) : undefined;
  return [sources.get(i), String(i), result?.text ?? '', call?.text ?? '', call ? String(call.i) : ''];
};
const leaves = new Map();
for (const l of read('tree')) if (l.l === 0 && l.i >= +from && sources.has(l.i)) leaves.set(l.i, l); // later entries win
const rows = [...leaves.values()].map((l) => ({ i: l.i, ids: foreignIds(l.text, allowed(l.i)) }));
const part = (name, rs) => console.log(`${name}: ${rs.filter((r) => r.ids.length).length}/${rs.length} leaves with foreign ids (${rs.length ? (100 * rs.filter((r) => r.ids.length).length / rs.length).toFixed(1) : '0'}%)`);
if (split) { part(`before ${split}`, rows.filter((r) => r.i < +split)); part(`from ${split}`, rows.filter((r) => r.i >= +split)); } else part(`from ${from}`, rows);
