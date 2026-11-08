import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { classifyCacheMisses } from '../src/cache-misses.ts';

// A bare --diag means "the diagnostics file next to usage.jsonl"; parseArgs cannot take an optional value.
const argv = process.argv.slice(2).flatMap((a, i, all) => (a === '--diag' && (i === all.length - 1 || all[i + 1].startsWith('--')) ? ['--diag=auto'] : [a]));
const { values } = parseArgs({ args: argv, options: { dir: { type: 'string' }, usage: { type: 'string' }, model: { type: 'string' }, since: { type: 'string' }, diag: { type: 'string' } } });
const dir = values.dir ?? join(homedir(), '.optchat', 'profiles', 'swlucas05');
values.usage ??= join(dir, 'usage.jsonl');
if (values.diag === 'auto') values.diag = join(dir, 'cache-diagnostics.jsonl');
if (!existsSync(values.usage)) {
  console.error(`No usage file at ${values.usage}. Usage: node --import tsx scripts/cache-misses.mjs [--dir PROFILE_DIR | --usage PATH/usage.jsonl] [--model claude-opus-5-5] [--since 2026-10-28] [--diag [PATH/cache-diagnostics.jsonl]]  (read-only; money = cacheWrite cost; dir defaults to the swlucas05 profile)`);
  process.exitCode = 2;
} else {
  const records = [];
  for await (const line of createInterface({ input: createReadStream(values.usage) })) {
    try { records.push(JSON.parse(line)); } catch { /* a torn line never breaks the report */ }
  }
  const read = async (file) => {
    const rows = [];
    for await (const line of createInterface({ input: createReadStream(file) })) {
      try { rows.push(JSON.parse(line)); } catch { /* torn line */ }
    }
    return rows;
  };
  // The diagnostics stream rotates at 1 MB into PATH.1 (compactor-diagnostics.ts); read the older file first.
  const diagnostics = values.diag
    ? (await Promise.all([`${values.diag}.1`, values.diag].filter(existsSync).map(read))).flat()
    : undefined;
  const round = (b) => ({ ...b, cacheWriteUsd: +b.cacheWriteUsd.toFixed(2) });
  const r = classifyCacheMisses(records, { model: values.model, since: values.since, diagnostics });
  console.log(JSON.stringify({
    totalUsd: +r.totalUsd.toFixed(2),
    byClass: Object.fromEntries(Object.entries(r.byClass).map(([k, v]) => [k, round(v)])),
    headChangeModelSwitch: round(r.modelSwitch),
    headChangeByCause: Object.fromEntries(Object.entries(r.headCause).map(([k, v]) => [k, round(v)])),
    headChangeByDay: Object.fromEntries(Object.entries(r.byDay).sort().map(([k, v]) => [k, round(v)])),
  }, null, 2));
}
