import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

test('stale destroy completion cannot delete a row owned by another reservation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takeover-fencing-'));
  const db = join(dir, 'db'), authority = {}, target = 'a'.repeat(64);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const docker: DockerRunner = async args => {
    if (args[0] === 'inspect' && args.includes('{{.Id}}|{{index .Config.Labels "optchat.computer.owner"}}')) {
      entered(); await new Promise<void>(resolve => { release = resolve; });
      return { code: 0, stdout: `${target}|owner`, stderr: '' };
    }
    if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const manager = new ComputerManager({ databasePath: db, owner: 'owner', image: 'image', operatorAuthority: authority, docker });
  try {
    const computer = await manager.create('profile', 'agent');
    const pending = manager.destroy(computer.id); await started;
    const second = new DatabaseSync(db);
    second.prepare('UPDATE computer_lifecycle SET token = ? WHERE id = ?').run('new-reservation', computer.id);
    second.close(); release();
    await assert.rejects(pending, /computer_transition/);
    assert.equal(manager.get(computer.id).state, 'removing');
  } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
