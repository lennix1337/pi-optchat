import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

test('owner cleanup reserves across connections before census and blocks different-key create', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-cleanup-'));
  const authority = {};
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0, runs = 0;
  const docker: DockerRunner = async args => {
    if (args[0] === 'ps' && ++calls === 1) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
    if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'run') runs++;
    return { code: 0, stdout: '', stderr: '' };
  };
  const options = { databasePath: join(dir, 'db'), owner: 'owner', image: 'image', operatorAuthority: authority, docker };
  const a = new ComputerManager(options), b = new ComputerManager(options);
  try {
    const pending = a.cleanup(); await started;
    await assert.rejects(b.create('other', 'agent'), /computer_cleanup_active/);
    assert.equal(runs, 0);
    assert.equal((await b.inspectRecovery(authority)).cleanupActive, true);
    release(); assert.equal(await pending, 0);
    await b.create('other', 'agent'); assert.equal(runs, 1);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});
