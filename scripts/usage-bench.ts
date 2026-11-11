// Opens, appends to, backfills and summarises a COPY of a usage ledger over and over, and prints heap after two collections plus RSS.
// Offline: the copy lives in os.tmpdir(); the source is only read.
//   node --experimental-transform-types --expose-gc scripts/usage-bench.ts --source <profile dir> [--rounds 2000]
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UsageLedger, emptyUsage, type UsageEntry } from '../src/usage.ts';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const source = arg('source'), rounds = Number(arg('rounds') ?? '2000');
if (!source) throw new Error('--source <profile dir> is required');
if (typeof globalThis.gc !== 'function') throw new Error('run with --expose-gc');
const dir = mkdtempSync(join(tmpdir(), 'usage-bench-'));
for (const file of ['usage.jsonl', 'usage.db']) if (existsSync(join(source, file))) copyFileSync(join(source, file), join(dir, file));
const mb = (n: number) => Math.round(n / 104857.6) / 10;
const line = (label: string) => { globalThis.gc!(); globalThis.gc!(); const m = process.memoryUsage(); console.log(`label=${label} heapMB=${mb(m.heapUsed)} rssMB=${mb(m.rss)} externalMB=${mb(m.external)}`); };
const entry = (n: number): UsageEntry => ({ id: randomUUID(), date: new Date().toISOString(), role: 'main', model: 'bench', provider: 'fixture', session: 'bench', kind: 'turn', failed: false,
  usage: { ...emptyUsage(), input: n, output: 1, totalTokens: n + 1 } } as UsageEntry);
let t0 = performance.now();
line('baseline'); const first = new UsageLedger(dir); line(`opened (${Math.round(performance.now() - t0)} ms)`);
for (let n = 1; n <= rounds; n++) {
  const ledger = n % 2 ? new UsageLedger(dir) : first;         // half the rounds open a fresh ledger, as a reload or a worker does
  ledger.add(entry(n));
  if (n % 5 === 0) ledger.summary('Today', 'bench'); if (n % 50 === 0) ledger.summary('All time' as never, 'bench');
  if (n % (rounds / 4) === 0) line(`after ${n} rounds`);
}
t0 = performance.now(); first.summary('Last 7 days', 'bench'); console.log(`summary ms=${Math.round(performance.now() - t0)} warnings=${JSON.stringify(first.warnings)}`);
line('final'); rmSync(dir, { recursive: true, force: true });
