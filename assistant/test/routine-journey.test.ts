import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoutines } from '../src/routines/manager.ts';
import { createRuntime } from '../src/runtime/worker.ts';
import { lines, withDir } from './runtime-support.ts';

const host = fileURLToPath(new URL('./routine-host.ts', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('local journey: a separate host process delivers one scripted briefing, and a pause from another process takes effect', { timeout: 60_000 }, () => withDir('routine-journey-', async dir => {
  writeFileSync(join(dir, 'provider.json'), JSON.stringify({ morning: 'Bom dia: 2 e-mails, 1 reuniao as 10h.', evening: 'must never be delivered' }));
  // A front end (TUI/HTTP) on the host's database: it edits routines and reads state, never takes the lease.
  const databasePath = join(dir, 'assistant.db');
  const front = createRuntime({ databasePath, owner: 'front', handlers: { brief: () => undefined } });
  const routines = createRoutines({ databasePath, runtime: front });
  try {
    const now = Date.now();
    const at = (ms: number) => ({ kind: 'interval' as const, minutes: 1, anchor: now + ms - 60_000 });
    routines.create({ id: 'morning', profileId: 'p', kind: 'brief', schedule: at(2_000), capabilities: ['read.calendar'], authorization: 'grant-1' });
    routines.create({ id: 'evening', profileId: 'p', kind: 'brief', schedule: at(7_000), capabilities: ['read.calendar'], authorization: 'grant-1' });
    routines.resume('morning', 'operator');
    routines.resume('evening', 'operator');
    assert.ok(routines.get('evening').nextRunAt! > Date.now(), 'evening is active and scheduled');

    const child = spawn(process.execPath, [host, dir, '10000'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise<number | null>(resolve => child.on('exit', resolve));

    // Wait for the first delivery, then pause the other routine before its slot, from this process.
    for (let i = 0; i < 80 && !lines(dir, 'tui.log').length; i++) await sleep(100);
    assert.equal(lines(dir, 'tui.log').length, 1, `morning delivered within 8s: ${stderr}`);
    assert.ok(Date.now() < now + 7_000, 'the pause happens before the evening slot');
    routines.pause('evening');
    assert.equal(await exited, 0, stderr);

    assert.deepEqual(lines(dir, 'tui.log').map(line => JSON.parse(line)), [{ id: `brief:morning:${new Date(now + 2_000).toISOString()}`, body: 'Bom dia: 2 e-mails, 1 reuniao as 10h.' }]);
    assert.deepEqual(routines.history('morning').map(run => run.status), ['done']);
    assert.deepEqual(routines.history('evening'), [], 'the paused routine never ran');
    assert.deepEqual([routines.get('evening').state, routines.get('evening').pausedReason], ['paused', 'operator']);
    assert.deepEqual(front.notifications().map(n => [n.channel, n.state]), [['tui', 'delivered']]);
  } finally { routines.close(); front.close(); }
}));
