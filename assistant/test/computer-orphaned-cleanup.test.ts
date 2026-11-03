import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

// Residue seen live (cmp_0b4d44f9): a service stopped mid owner-cleanup, after reserving and before any `docker rm`,
// left an `active` owner fence and a `removing` row with no target. Every later start refused with computer_cleanup_active.
test('an owner cleanup left by a dead process is taken over, so create works again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orphan-cleanup-'));
  const docker: DockerRunner = async args => (args[0] === 'inspect' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' });
  const options = { databasePath: join(dir, 'db'), owner: 'owner', image: 'image', operatorAuthority: {}, docker };
  new ComputerManager(options).close();
  const db = new DatabaseSync(options.databasePath);
  db.prepare("INSERT INTO computers (id, owner, profile, agent, container, state, expires) VALUES ('cmp_dead', 'owner', 'p', 'executor', 'optchat-computer-dead', 'removing', 0)").run();
  db.prepare("INSERT INTO computer_lifecycle (id, token, target, phase) VALUES ('cmp_dead', 'dead-token', NULL, 'active')").run();
  db.prepare("INSERT INTO computer_owner_cleanup (owner, token, phase) VALUES ('owner', 'dead-fence', 'active')").run();
  db.close();
  const manager = new ComputerManager(options);
  try {
    await assert.rejects(manager.create('p', 'executor'), /computer_cleanup_active/);
    assert.equal(await manager.cleanup(), 0);
    assert.deepEqual(manager.list(), []);
    await manager.create('p', 'executor');
  } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
