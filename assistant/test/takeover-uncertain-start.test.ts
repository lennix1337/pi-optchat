import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

const target = 'a'.repeat(64);
const OWNER_ID_FORMAT = '{{.Id}}|{{index .Config.Labels "optchat.computer.owner"}}';

test('an unverifiable identity at takeover start restores the agent and never creates a container', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uncertain-start-'));
  const authority = {};
  let runs = 0, unverifiable = false;
  const docker: DockerRunner = async args => {
    if (args[0] === 'run') { runs++; return { code: 0, stdout: target, stderr: '' }; }
    if (args[0] === 'inspect' && args.includes(OWNER_ID_FORMAT) && unverifiable) return { code: 0, stdout: `${target}|owner`, stderr: '', uncertain: true }; // looks valid, but the read never settled
    if (args[0] === 'inspect' && args.includes(OWNER_ID_FORMAT)) return { code: 0, stdout: `${target}|owner`, stderr: '' };
    if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const manager = new ComputerManager({ databasePath: join(dir, 'db'), owner: 'owner', image: 'optchat-computer-browser:1', operatorAuthority: authority, docker });
  try {
    const computer = await manager.create('profile', 'agent');
    assert.equal(runs, 1);
    unverifiable = true;
    await assert.rejects(manager.beginGraphical(computer.id, authority), /computer_graphical_start_failed/);
    assert.equal(runs, 1, 'takeover never starts a second container');
    assert.equal(manager.get(computer.id).state, 'ready');
    assert.equal((await manager.inspectRecovery(authority)).computers.length, 0);
    unverifiable = false;
    const started = await manager.beginGraphical(computer.id, authority);
    assert.equal(started.target, target);
    await manager.endGraphical(computer.id, started.generation, authority);
  } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a viewer that cannot be proven stopped keeps the agent fenced until a retry stops it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uncertain-stop-'));
  const authority = {};
  let stopOutcome: 'uncertain' | 'stopped' = 'uncertain', stops = 0;
  const docker: DockerRunner = async args => {
    if (args[0] === 'run') return { code: 0, stdout: target, stderr: '' };
    if (args[0] === 'inspect' && args.includes(OWNER_ID_FORMAT)) return { code: 0, stdout: `${target}|owner`, stderr: '' };
    if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) return { code: 0, stdout: 'true', stderr: '' };
    if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'exec' && args.at(-2) === '-c' && args.at(-3) === 'sh') {
      stops++;
      return stopOutcome === 'uncertain' ? { code: 1, stdout: '', stderr: '', uncertain: true } : { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const manager = new ComputerManager({ databasePath: join(dir, 'db'), owner: 'owner', image: 'optchat-computer-browser:1', operatorAuthority: authority, docker });
  try {
    const computer = await manager.create('profile', 'agent');
    const started = await manager.beginGraphical(computer.id, authority);
    await assert.rejects(manager.endGraphical(computer.id, started.generation, authority), /computer_graphical_cleanup_uncertain/);
    assert.equal(manager.get(computer.id).state, 'graphical');
    await assert.rejects(manager.exec(computer.id, ['true']), /computer_human_control/);
    stopOutcome = 'stopped';
    await manager.endGraphical(computer.id, started.generation, authority);
    assert.equal(manager.get(computer.id).state, 'ready');
    assert.equal(stops, 2);
    assert.equal((await manager.exec(computer.id, ['true'])).code, 0);
  } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
