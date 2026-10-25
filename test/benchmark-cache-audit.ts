import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { summarizeCache } from './benchmark-cache.ts';

const directory = process.argv[2];
const output = process.argv[3];
if (!directory || !output) throw new Error('Usage: tsx test/benchmark-cache-audit.ts <receipts-directory> <output.json>');
const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
const tasks = await Promise.all(files.map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
if (!tasks.length || tasks.some(task => !Array.isArray(task.providerEvidence?.usage))) throw new Error('Missing provider usage evidence.');
const report = { source: resolve(directory), ...summarizeCache(tasks),
  limitations: ['Provider-reported tokens; not a measurement of latency or correctness.',
    'Old receipts cannot distinguish prefix mutation from provider routing/availability.',
    'Per-task cold starts and cumulative long-chat footer ratios are different workloads.'] };
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
