import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { classifyCacheMisses } from '../src/cache-misses.ts';

// A bare --diag means "the diagnostics file next to usage.jsonl"; parseArgs cannot take an optional value.
const argv = process.argv.slice(2).flatMap((a, i, all) => (a === '--diag' && (i === all.length - 1 || all[i + 1].startsWith('--')) ? ['--diag=auto'] : [a]));
const USAGE = 'Usage: node scripts/cache-misses.mjs [--dir PROFILE_DIR | --usage PATH/usage.jsonl] [--model claude-opus-5-5] [--since 2026-10-28] [--diag [PATH/cache-diagnostics.jsonl]] [--days N]  (read-only; money = cacheWrite cost; dir defaults to the swlucas05 profile; headChangeByDay lists the last N days of data, default 14, 0 = all)';
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
let values;
try {
  ({ values } = parseArgs({ args: argv, options: { dir: { type: 'string' }, usage: { type: 'string' }, model: { type: 'string' }, since: { type: 'string' }, diag: { type: 'string' }, days: { type: 'string' } } }));
} catch (error) {
  const option = /'(--?[\w-]+)'/.exec(error.message)?.[1];
  console.error(`${option ? `unknown option ${option}` : error.message}. ${USAGE}`);
  process.exit(2);
}
const days = values.days === undefined ? 14 : Number(values.days);
if (!Number.isInteger(days) || days < 0) {
  console.error(`--days needs a whole number >= 0. ${USAGE}`);
  process.exit(2);
}
const dir = values.dir ?? join(homedir(), '.optchat', 'profiles', 'swlucas05');
values.usage ??= join(dir, 'usage.jsonl');
if (values.diag === 'auto') values.diag = join(dir, 'cache-diagnostics.jsonl');
if (values.diag && !existsSync(values.diag) && !existsSync(`${values.diag}.1`)) {
  console.error(`no diagnostics file at ${values.diag}; --diag takes an optional path, not a mode name. ${USAGE}`);
  process.exitCode = 2;
} else if (!existsSync(values.usage)) {
  console.error(`No usage file at ${values.usage}. ${USAGE}`);
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
  // Days are counted back from the newest day in the data, so a report never depends on today's date.
  const lastDays = (sorted, n) => {
    if (n === 0 || sorted.length === 0) return sorted;
    const cutoff = Date.parse(sorted.at(-1)[0]) - (n - 1) * 86_400_000;
    return sorted.filter(([day]) => Date.parse(day) >= cutoff);
  };
  const round = (b) => ({ ...b, cacheWriteUsd: +b.cacheWriteUsd.toFixed(2) });
  const r = classifyCacheMisses(records, { model: values.model, since: values.since, diagnostics });
  console.log(JSON.stringify({
    totalUsd: +r.totalUsd.toFixed(2),
    byClass: Object.fromEntries(Object.entries(r.byClass).map(([k, v]) => [k, round(v)])),
    headChangeModelSwitch: round(r.modelSwitch),
    headChangeByCause: Object.fromEntries(Object.entries(r.headCause).map(([k, v]) => [k, round(v)])),
    afterIdleByDay: Object.fromEntries(lastDays(Object.entries(r.afterIdle).sort(), days).map(([k, v]) => [k, round(v)])),
    headChangeByDay: Object.fromEntries(lastDays(Object.entries(r.byDay).sort(), days).map(([k, v]) => [k, round(v)])),
  }, null, 2));
}
