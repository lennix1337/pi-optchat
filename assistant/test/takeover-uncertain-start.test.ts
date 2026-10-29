import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

test('uncertain run stays fenced even when the daemon creates the human container later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uncertain-start-'));
  const authority = {}, target = 'a'.repeat(64);
  let late = false, humanName = '';
  const docker: DockerRunner = async args => {
    if (args[0] === 'run' && args.includes('optchat-computer-browser:1')) {
      humanName = args[args.indexOf('--name') + 1]!;
      if (humanName.startsWith('optchat-human-')) return { code: 1, stdout: '', stderr: '', uncertain: true };
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'inspect' && args.at(-1) === humanName && late) return { code: 0, stdout: JSON.stringify({ Id: target, Config: { Labels: { 'optchat.computer.owner': 'owner' } } }), stderr: '' };
    if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const manager = new ComputerManager({ databasePath: join(dir, 'db'), owner: 'owner', image: 'optchat-computer-browser:1', operatorAuthority: authority, docker });
  try {
    const computer = await manager.create('profile', 'agent');
    await assert.rejects(manager.beginGraphical(computer.id, authority), /computer_graphical_start_uncertain/);
    const initial = await manager.inspectRecovery(authority);
    assert.equal(initial.computers[0]?.phase, 'uncertain');
    assert.equal(initial.computers[0]?.inspection, 'unavailable');
    late = true;
    const after = await manager.inspectRecovery(authority);
    assert.equal(after.computers[0]?.target, target);
    await assert.rejects(manager.endGraphical(computer.id, after.computers[0]!.generation!, authority), /computer_graphical_start_uncertain/);
    await assert.rejects(manager.exec(computer.id, ['true']), /computer_human_control/);
  } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
