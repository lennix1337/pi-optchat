import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

test('create reserves the identity before Docker and refuses concurrent create or cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-create-race-'));
  const authority = {};
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let runs = 0;
  const docker: DockerRunner = async args => {
    if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'run') { runs++; if (runs === 1) { entered(); await new Promise<void>(resolve => { release = resolve; }); } }
    return { code: 0, stdout: '', stderr: '' };
  };
  const options = { databasePath: join(dir, 'db'), owner: 'owner', image: 'image', operatorAuthority: authority, docker };
  const a = new ComputerManager(options), b = new ComputerManager(options);
  try {
    const pending = a.create('profile', 'agent');
    await started;
    await assert.rejects(b.create('profile', 'agent'), /computer_transition/);
    await assert.rejects(b.cleanup(), /computer_transition/);
    const id = a.list()[0]!.id;
    await assert.rejects(b.destroy(id), /computer_transition/);
    release();
    assert.equal((await pending).state, 'ready');
    assert.equal(runs, 1);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});
