#!/usr/bin/env node
// Rate of one-message memory leaves that name ids (commitments, ops, hashes, message numbers) their own message lacks.
// Usage: node --experimental-transform-types scripts/foreign-id-rate.mjs [profileDir] [fromId] [splitId]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { foreignIds } from '../src/carried-ids.ts';

const [d, f, split = ''] = process.argv.slice(2);
const dir = d || join(homedir(), '.optchat', 'profiles', 'swlucas05');
const from = f || '104200';
const date = new Date().toISOString().slice(0, 10);
const read = (sub) => readFileSync(join(dir, sub, `${date}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const msgs = new Map(read('main').map((m) => [m.i, m]));
const sources = new Map([...msgs].map(([i, m]) => [i, m.text]));
// Same allowance as the compactor (compactor.ts `own`): the message's own id, and for a result its call's text and id.
const allowed = (i) => { const call = msgs.get(i)?.kind === 'echo' ? msgs.get(i - 1) : undefined; return [sources.get(i), String(i), call?.kind === 'tool' ? call.text : '', call?.kind === 'tool' ? String(call.i) : '']; };
const leaves = new Map();
for (const l of read('tree')) if (l.l === 0 && l.i >= +from && sources.has(l.i)) leaves.set(l.i, l); // later entries win
const rows = [...leaves.values()].map((l) => ({ i: l.i, ids: foreignIds(l.text, allowed(l.i)) }));
const part = (name, rs) => console.log(`${name}: ${rs.filter((r) => r.ids.length).length}/${rs.length} leaves with foreign ids (${rs.length ? (100 * rs.filter((r) => r.ids.length).length / rs.length).toFixed(1) : '0'}%)`);
if (split) { part(`before ${split}`, rows.filter((r) => r.i < +split)); part(`from ${split}`, rows.filter((r) => r.i >= +split)); } else part(`from ${from}`, rows);
