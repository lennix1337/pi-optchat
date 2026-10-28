import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime, type EffectInput } from '../src/runtime/worker.ts';

const child = fileURLToPath(new URL('./runtime-child.ts', import.meta.url));

/** Runs one disposable worker process to completion (or to its injected crash) and returns its exit status. */
export function runWorker(dir: string, owner: string, crashAt = '', mode = ''): number | null {
  const result = spawnSync(process.execPath, [child, dir, owner, crashAt, mode], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  if (result.error) throw result.error;
  if (!crashAt && result.status !== 0) throw new Error(`worker_exit_${result.status}: ${result.stderr}`);
  return result.status;
}

/** A producer handle: it enqueues and reads but never takes the lease, like a TUI or HTTP front end. */
export function producer(dir: string) {
  return createRuntime({ databasePath: join(dir, 'runtime.db'), owner: 'producer', handlers: { write: () => undefined } });
}

export function effect(operationId: string, text: string): EffectInput {
  return {
    version: 1, operationId, profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'mail', action: 'send',
    account: 'a@example.test', destination: 'b@example.test', policyVersion: 'v1', expiresAt: Date.now() + 600_000,
    payloadBase64: Buffer.from(text).toString('base64'),
  };
}

export function lines(dir: string, name: string): string[] {
  const path = join(dir, name);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

export async function withDir(prefix: string, fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try { await fn(dir); }
  finally {
    for (let attempt = 0; ; attempt++) {
      try { rmSync(dir, { recursive: true, force: true }); break; }
      catch (error) {
        if (attempt >= 10 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }
}
