// Disposable worker process for runtime tests: node runtime-child.ts <dir> <owner> [crashAt] [mode]
// It is a separate process with no TUI. `crashAt` names a durable boundary where it dies abruptly.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGateway } from '../src/policy/gateway.ts';
import { createRuntime } from '../src/runtime/worker.ts';

const [dir, owner, crashAt = '', mode = ''] = process.argv.slice(2);
const gateway = createGateway({
  databasePath: join(dir, 'gateway.db'), profileId: 'p', operatorAuthority: {},
  policy: () => mode === 'review' ? 'review' : 'allow', inspect: () => ({ decision: 'allow', reasons: [] }),
});
const runtime = createRuntime({
  databasePath: join(dir, 'runtime.db'), owner, gateway, leaseMs: 1,
  handlers: {
    // Idempotent local task: rewriting the same file with the same content is safe to repeat.
    write: input => { const { name, text } = input as { name: string; text: string }; writeFileSync(join(dir, name), text); return { bytes: text.length }; },
  },
  adapters: {
    mail: {
      invoke: bytes => { appendFileSync(join(dir, 'sink.log'), `${Buffer.from(bytes).toString()}\n`); return { accepted: true }; },
      reconcile: () => mode === 'reconcile' && existsSync(join(dir, 'sink.log')) && readFileSync(join(dir, 'sink.log'), 'utf8').length ? 'done' : 'unknown',
    },
  },
  boundary: name => { if (name === crashAt) process.kill(process.pid, 'SIGKILL'); },
});
if (!await runtime.acquire()) { runtime.close(); gateway.close(); process.exit(3); }
while (await runtime.runOnce());
await runtime.deliver('tui', note => { appendFileSync(join(dir, 'tui.log'), `${note.id}\n`); });
await runtime.stop();
runtime.close(); gateway.close();
