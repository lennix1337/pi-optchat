import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { classifyCacheMisses } from '../src/cache-misses.ts';

const { values } = parseArgs({ options: { usage: { type: 'string' }, model: { type: 'string' }, since: { type: 'string' } } });
if (!values.usage) {
  console.error('Usage: node --import tsx scripts/cache-misses.mjs --usage PATH/usage.jsonl [--model claude-opus-5-5] [--since 2026-10-28]  (read-only; money = cacheWrite cost)');
  process.exitCode = 2;
} else {
  const records = [];
  for await (const line of createInterface({ input: createReadStream(values.usage) })) {
    try { records.push(JSON.parse(line)); } catch { /* a torn line never breaks the report */ }
  }
  const round = (b) => ({ ...b, cacheWriteUsd: +b.cacheWriteUsd.toFixed(2) });
  const r = classifyCacheMisses(records, { model: values.model, since: values.since });
  console.log(JSON.stringify({
    totalUsd: +r.totalUsd.toFixed(2),
    byClass: Object.fromEntries(Object.entries(r.byClass).map(([k, v]) => [k, round(v)])),
    headChangeByDay: Object.fromEntries(Object.entries(r.byDay).sort().map(([k, v]) => [k, round(v)])),
  }, null, 2));
}
