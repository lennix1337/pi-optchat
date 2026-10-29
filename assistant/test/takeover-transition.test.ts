import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

test('pending pause fences takeover across connections until transition finishes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takeover-transition-'));
  const authority = {};
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const docker: DockerRunner = async args => {
    if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'pause') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
    return { code: 0, stdout: '', stderr: '' };
  };
  const options = { databasePath: join(dir, 'db'), owner: 'owner', image: 'image', operatorAuthority: authority, docker };
  const a = new ComputerManager(options), b = new ComputerManager(options);
  try {
    const computer = await a.create('profile', 'agent');
    const pending = a.pause(computer.id);
    await started;
    await assert.rejects(b.takeover(computer.id, authority), /computer_transition/);
    await assert.rejects(b.exec(computer.id, ['true']), /computer_transition/);
    release(); await pending;
    await b.takeover(computer.id, authority);
    await assert.rejects(a.pause(computer.id), /computer_human_control/);
    assert.equal(a.get(computer.id).state, 'human');
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});
