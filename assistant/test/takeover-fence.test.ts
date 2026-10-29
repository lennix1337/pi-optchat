import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

test('takeover refuses in-flight agent exec and capture across manager connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takeover-fence-'));
  const authority = {};
  let release!: () => void;
  let entered!: () => void;
  let pending = new Promise<void>(resolve => { entered = resolve; });
  const docker: DockerRunner = async args => {
    if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'exec') {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    }
    return { code: 0, stdout: 'ok', stderr: '' };
  };
  const options = { databasePath: join(dir, 'state.sqlite'), owner: 'owner', image: 'image', operatorAuthority: authority, docker };
  const a = new ComputerManager(options);
  const b = new ComputerManager(options);
  try {
    const computer = await a.create('profile', 'agent');
    for (const operation of [() => a.exec(computer.id, ['true']), () => a.capture(computer.id)]) {
      const work = operation();
      await pending;
      await assert.rejects(b.takeover(computer.id, authority), /computer_operations_active/);
      release();
      await work;
      pending = new Promise<void>(resolve => { entered = resolve; });
    }
    await b.takeover(computer.id, authority);
    await assert.rejects(a.exec(computer.id, ['true']), /computer_human_control/);
    await assert.rejects(a.capture(computer.id), /computer_human_control/);
    await assert.rejects(a.resume(computer.id, authority), /computer_human_control/);
    b.handBack(computer.id, authority);
  } finally {
    a.close(); b.close(); rmSync(dir, { recursive: true, force: true });
  }
});
