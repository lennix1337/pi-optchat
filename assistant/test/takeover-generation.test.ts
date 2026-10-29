import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerManager } from '../src/computer/manager.ts';

test('human container is fresh and stale generation cannot hand back a replacement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takeover-generation-'));
  const authority = {};
  const manager = new ComputerManager({ databasePath: join(dir, 'db'), owner: `generation-${Date.now()}`, image: 'optchat-computer-takeover:local', operatorAuthority: authority });
  let active: string | undefined;
  let id = '';
  try {
    const computer = await manager.create('fixture', 'agent'); id = computer.id;
    const agentTarget = await manager.isolatedTarget(id);
    const first = await manager.beginGraphical(id, authority); active = first.generation;
    assert.notEqual(first.target, agentTarget);
    assert.throws(() => manager.handBack(id, authority), /computer_not_in_takeover/);
    await assert.rejects(manager.reconcileGraphical(id, first.generation, 'b'.repeat(64), authority), /computer_graphical_reconcile_refused/);
    await manager.reconcileGraphical(id, first.generation, first.target, authority); active = undefined;
    const second = await manager.beginGraphical(id, authority); active = second.generation;
    assert.notEqual(second.target, first.target);
    await assert.rejects(manager.endGraphical(id, first.generation, authority), /computer_graphical_stale/);
    assert.equal(manager.get(id).state, 'graphical');
    await manager.endGraphical(id, second.generation, authority); active = undefined;
  } finally {
    if (active) await manager.endGraphical(id, active, authority);
    await manager.cleanup(); manager.close(); rmSync(dir, { recursive: true, force: true });
  }
});
