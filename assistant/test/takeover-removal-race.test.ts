import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

test('one destroy owns reservation through completion; replacement graphical generation survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takeover-removal-race-'));
  const authority = {}, target = 'a'.repeat(64);
  let release!: () => void, entered!: () => void, block = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const docker: DockerRunner = async args => {
    if (args[0] === 'inspect' && args.includes('{{.Id}}|{{index .Config.Labels "optchat.computer.owner"}}')) {
      if (block) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
      return { code: 0, stdout: `${target}|owner`, stderr: '' };
    }
    if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'run') return { code: 0, stdout: args.includes('optchat-human-') ? target : target, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const options = { databasePath: join(dir, 'db'), owner: 'owner', image: 'image', operatorAuthority: authority, docker };
  const a = new ComputerManager(options), b = new ComputerManager(options);
  try {
    const computer = await a.create('profile', 'agent'); block = true;
    const first = a.destroy(computer.id); await started;
    await assert.rejects(b.destroy(computer.id), /computer_transition/);
    await assert.rejects(b.cleanup(), /computer_transition/);
    await assert.rejects(b.create('profile', 'agent'), /computer_transition/);
    block = false; release(); await first;
    const replacement = await b.create('profile', 'agent');
    await b.beginGraphical(replacement.id, authority);
    assert.equal(a.get(replacement.id).state, 'graphical');
    await assert.rejects(a.exec(replacement.id, ['true']), /computer_human_control/);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});
