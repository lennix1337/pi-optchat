import { parseArgs } from 'node:util';
import { repairAiMemoryBlocks } from '../src/ai-memory-repair.ts';

const { values } = parseArgs({ options: { 'memory-dir': { type: 'string' }, profile: { type: 'string' }, blocks: { type: 'string' }, apply: { type: 'boolean', default: false } } });
if (!values['memory-dir'] || !values.profile || !values.blocks || !/^\d+(?:,\d+)*$/.test(values.blocks)) {
  console.error('Usage: node --import tsx scripts/repair-ai-memory.mjs --memory-dir PATH --profile NAME --blocks INDEX[,INDEX] [--apply] (max 16; dry run by default; no cursor reset)');
  process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(await repairAiMemoryBlocks(values['memory-dir'], values.profile, values.blocks.split(',').map(Number), values.apply))); }
  catch { console.error('Repair failed. Inspect the source snapshot and named remote page versions before retrying; forward sync was not reset.'); process.exitCode = 1; }
}
