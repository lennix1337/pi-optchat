// Disposable assistant host for the routine journey: node routine-host.ts <dir> <runMs>
// Real clock, its own process and SQLite connection. The "provider" is a script
// file of canned replies; nothing leaves the machine.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime/worker.ts';
import { createRoutines } from '../src/routines/manager.ts';

const [dir, runMs] = process.argv.slice(2);
const databasePath = join(dir, 'assistant.db');
const script = JSON.parse(readFileSync(join(dir, 'provider.json'), 'utf8')) as Record<string, string>;
const runtime = createRuntime({
  databasePath, owner: 'host',
  handlers: {
    brief: input => {
      const { routineId, slot } = input as { routineId: string; slot: string };
      const reply = script[routineId];
      if (reply === undefined) throw new Error('no_scripted_reply');
      runtime.notify(`brief:${routineId}:${slot}`, ['tui'], reply);
      return { chars: reply.length };
    },
  },
});
const routines = createRoutines({ databasePath, runtime });
if (!await runtime.acquire()) process.exit(3);
const deadline = Date.now() + Number(runMs);
while (Date.now() < deadline) {
  routines.tick();
  while (await runtime.runOnce());
  routines.tick();
  await runtime.deliver('tui', note => { appendFileSync(join(dir, 'tui.log'), `${JSON.stringify(note)}\n`); });
  await new Promise(resolve => setTimeout(resolve, 100));
}
await runtime.stop();
routines.close(); runtime.close();
