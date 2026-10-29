import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

test('operation identity prevents an old release from clearing a replacement lease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-lease-'));
  const authority = {};
  const docker: DockerRunner = async args => args[0] === 'inspect'
    ? { code: 1, stdout: '', stderr: '' }
    : { code: 0, stdout: '', stderr: '' };
  const manager = new ComputerManager({ databasePath: join(dir, 'db'), owner: 'owner', image: 'image', operatorAuthority: authority, docker });
  try {
    const computer = await manager.create('profile', 'agent');
    const first = manager.beginOperation(computer.id);
    const second = manager.beginOperation(computer.id);
    first.finish(); first.finish();
    await assert.rejects(manager.takeover(computer.id, authority), /computer_operations_active/);
    second.finish();
    await manager.takeover(computer.id, authority);
  } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('known failing exec releases lease; uncertain transport retains it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-lease-'));
  const authority = {};
  let uncertain = false;
  const docker: DockerRunner = async args => {
    if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'exec') return { code: 1, stdout: '', stderr: '', uncertain };
    return { code: 0, stdout: '', stderr: '' };
  };
  const manager = new ComputerManager({ databasePath: join(dir, 'db'), owner: 'owner', image: 'image', operatorAuthority: authority, docker });
  try {
    const computer = await manager.create('profile', 'agent');
    assert.equal((await manager.exec(computer.id, ['false'])).code, 1);
    await manager.takeover(computer.id, authority);
    manager.handBack(computer.id, authority);
    uncertain = true;
    await manager.exec(computer.id, ['false']);
    await assert.rejects(manager.takeover(computer.id, authority), /computer_operations_active/);
  } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
