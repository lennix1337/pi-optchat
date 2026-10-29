import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerManager } from '../src/computer/manager.ts';
import { beginGraphicalTakeover } from '../src/computer/graphical-takeover.ts';

test('failed graphical startup restores agent access and leaves the agent container untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takeover-start-'));
  const authority = {};
  const manager = new ComputerManager({ databasePath: join(dir, 'db'), owner: `start-${Date.now()}`, image: 'optchat-computer-browser:1', operatorAuthority: authority });
  try {
    const computer = await manager.create('fixture', 'agent');
    await assert.rejects(beginGraphicalTakeover({ computers: manager, id: computer.id, authority, revocation: new AbortController().signal, authorizeOwner: () => false }), /takeover_not_ready|takeover_start_failed/);
    assert.equal(manager.get(computer.id).state, 'ready');
    assert.equal((await manager.exec(computer.id, ['true'])).code, 0);
  } finally { await manager.cleanup(); manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
