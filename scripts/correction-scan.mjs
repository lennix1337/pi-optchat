#!/usr/bin/env node
import { scanCorrections, sessionsDir } from '../src/correction-scan.ts';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--since' || !/^[1-9]\d*d$/.test(args[1])) {
  console.error('Usage: node scripts/correction-scan.mjs --since 7d'); process.exit(2);
}
const now = Date.now();
const result = scanCorrections(sessionsDir(), now - Number(args[1].slice(0, -1)) * 86_400_000, now);
console.log('Regra                   Violações  Depois da trava');
for (const row of result) console.log(`${row.id.padEnd(23)} ${String(row.count).padEnd(10)} ${row.afterGuard ?? '-'}`);
console.log(JSON.stringify(result));
