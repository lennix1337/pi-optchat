// What one percent of each model account's quota is worth in API prices, and the last weeks side by side, read-only.
// Sources: <profileDir>/quota-history.jsonl (written every 5 minutes by the extension), <profileDir>/usage.jsonl, Pi's
// provider-failover-state.json cache (the accounts and their resets) and models-store.json (prices for calls recorded at cost 0).
//
// usage: node --experimental-transform-types scripts/quota-report.mjs <profileDir> [--weeks N] [--cache FILE] [--rates FILE]
import { parseArgs } from 'node:util';
import { loadEconomy } from '../src/quota-economy.ts';
import { reportText } from '../src/quota-format.ts';
import { QUOTA_FILE } from '../src/quota-health.ts';
import { readJsonOr } from '../src/store.ts';

const USAGE = 'usage: node --experimental-transform-types scripts/quota-report.mjs <profileDir> [--weeks N] [--cache FILE] [--rates FILE]  (read-only; weeks defaults to 2)';
let parsed;
try { parsed = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { weeks: { type: 'string' }, cache: { type: 'string' }, rates: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }); }
catch (error) { console.error(`${error.message}. ${USAGE}`); process.exit(2); }
const { values, positionals } = parsed;
if (values.help) { console.log(USAGE); process.exit(0); }
const weeks = values.weeks === undefined ? 2 : Number(values.weeks);
if (positionals.length !== 1 || !Number.isInteger(weeks) || weeks < 1 || weeks > 52) { console.error(USAGE); process.exit(2); }

const cacheFile = values.cache ?? QUOTA_FILE;
const economy = loadEconomy({ dir: positionals[0], weeks, cacheFile, ratesFile: values.rates });
console.log(reportText(readJsonOr(cacheFile, {}), economy));
