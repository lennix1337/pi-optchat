// Offline retained-heap deltas; source data is copied before either loader can write.
// node --expose-gc --experimental-transform-types scripts/heap-owners.ts --source <profile> --session <session.jsonl>
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Memory } from '../src/memory.ts';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
const source = arg('source'), session = arg('session');
if (!source || !session || !globalThis.gc) throw new Error('--source, --session and --expose-gc are required');
const scratch = mkdtempSync(join(tmpdir(), 'heap-owners-'));
try {
  const profile = join(scratch, 'profile'); mkdirSync(profile);
  for (const name of ['main', 'tree', 'view.json', 'head.json']) {
    const path = join(source, name);
    if (existsSync(path)) cpSync(path, join(profile, name), { recursive: true, dereference: true });
  }
  const copied = join(scratch, 'session.jsonl'); copyFileSync(session, copied);
  const phases: { phase: string; heapBytes: number; externalBytes: number; deltaBytes: number }[] = [];
  function sample(phase: string) {
    globalThis.gc!(); globalThis.gc!();
    const usage = process.memoryUsage();
    phases.push({ phase, heapBytes: usage.heapUsed, externalBytes: usage.external, deltaBytes: usage.heapUsed - (phases.at(-1)?.heapBytes ?? usage.heapUsed) });
  }
  sample('baseline');
  const manager = SessionManager.open(copied);
  sample('session');
  const memory = await Memory.open(profile, async () => { throw new Error('unexpected compression'); }, () => {});
  sample('memory');
  const rendered = memory.render();
  sample('render');
  console.log(JSON.stringify({ phases, sessionEntries: manager.getEntries().length, memory: memory.stats(), renderedChars: rendered.length,
    note: 'Sequential GC heap deltas, not exclusive ownership; shared references and external buffers are not attributed.' }));
  await memory.close();
} finally { rmSync(scratch, { recursive: true, force: true }); }
