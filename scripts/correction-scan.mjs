#!/usr/bin/env node
import { scanCorrections, sessionsDir } from '../src/correction-scan.ts';
const json = process.argv.includes('--json');
const args = process.argv.slice(2).filter(arg => arg !== '--json');
if (args.length !== 2 || args[0] !== '--since' || !/^[1-9]\d*d$/.test(args[1])) {
  console.error('Usage: node scripts/correction-scan.mjs --since 7d [--json]'); process.exit(2);
}
const now = Date.now();
const result = scanCorrections(sessionsDir(), now - Number(args[1].slice(0, -1)) * 86_400_000, now);
if (json) { console.log(JSON.stringify(result)); process.exit(0); }
console.log('Regra                   Violações  Depois da trava  Barradas pela checagem');
for (const row of result) console.log(`${row.id.padEnd(23)} ${String(row.count).padEnd(10)} ${String(row.afterGuard ?? '-').padEnd(16)} ${row.caught ?? '-'}`);
console.log(JSON.stringify(result));
