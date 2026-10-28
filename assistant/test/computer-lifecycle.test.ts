import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { dockerCli, type DockerRunner } from '../src/computer/docker.ts';
import { inspectContainer, withComputers } from './computer-support.ts';

test('create is idempotent per agent and restores a container removed behind its back', () => withComputers(async ({ computers }) => {
  const first = await computers.create('p', 'agent-a');
  const again = await computers.create('p', 'agent-a');
  assert.equal(again.id, first.id);
  assert.equal(computers.list().length, 1);
  assert.equal((await dockerCli(['rm', '--force', first.container])).code, 0);
  const restored = await computers.create('p', 'agent-a');
  assert.equal(restored.container, first.container);
  assert.equal((await computers.exec(restored.id, ['echo', 'back'])).stdout.trim(), 'back');
}));

test('a paused computer refuses agent work; only the operator resumes it', () => withComputers(async ({ computers, authority }) => {
  const a = await computers.create('p', 'agent-a');
  await computers.pause(a.id);
  assert.equal((await inspectContainer(a.container))?.State.Paused, true);
  await assert.rejects(computers.exec(a.id, ['true']), /computer_paused/);
  await assert.rejects(computers.capture(a.id), /computer_paused/);
  await assert.rejects(computers.resume(a.id, {}), /unauthorized/);
  await computers.resume(a.id, authority);
  assert.equal((await computers.exec(a.id, ['echo', 'ok'])).stdout.trim(), 'ok');
}));

test('an idle computer expires, refuses work and is swept with its container', () => {
  let now = Date.now();
  return withComputers(async ({ computers }) => {
    const a = await computers.create('p', 'agent-a');
    now += 4_000;
    await assert.rejects(computers.exec(a.id, ['true']), /computer_expired/);
    assert.deepEqual(await computers.sweep(), [a.id]);
    assert.equal(await inspectContainer(a.container), undefined);
    assert.throws(() => computers.get(a.id), /computer_unknown/);
  }, { now: () => now, ttlMs: 2_000 });
});

test('cleanup and destroy touch only this owner\'s computers, including ones a crashed process left behind', () => withComputers(async outer => {
  const foreign = await outer.computers.create('p', 'agent-x');
  await withComputers(async ({ dir, computers, open }) => {
    const mine = await computers.create('p', 'agent-a');
    assert.throws(() => computers.get(foreign.id), /computer_unknown/, 'another owner\'s computer is invisible');
    await assert.rejects(computers.destroy(foreign.id), /computer_unknown/);
    // A fresh process with an empty database still finds and removes its own stray container by label.
    const stray = open({ databasePath: join(dir, 'fresh-process.db') });
    try { assert.equal(await stray.cleanup(), 1); } finally { stray.close(); }
    assert.equal(await inspectContainer(mine.container), undefined);
  });
  assert.equal((await inspectContainer(foreign.container))?.State.Running, true, 'the other owner\'s container survives');
}));

test('cleanup lists only this owner\'s containers and still re-checks each label before removing', () => withComputers(async outer => {
  const foreign = await outer.computers.create('p', 'agent-x');
  await withComputers(async ({ owner, computers, open }) => {
    await computers.create('p', 'agent-a');
    const listings: string[][] = [];
    // A listing that also returns another owner's container, as a wrong filter or a reused name would.
    const docker: DockerRunner = async (args, options) => {
      const result = await dockerCli(args, options);
      if (args[0] !== 'ps') return result;
      listings.push([...args]);
      return { ...result, stdout: `${result.stdout}${foreign.container}\n` };
    };
    const cleaner = open({ docker });
    try { assert.equal(await cleaner.cleanup(), 1); } finally { cleaner.close(); }
    assert.deepEqual(listings.map(args => args[args.indexOf('--filter') + 1]), [`label=optchat.computer.owner=${owner}`]);
  });
  assert.equal((await inspectContainer(foreign.container))?.State.Running, true, 'a listed foreign container is not removed');
}));

test('a command past its deadline is killed inside the computer, not just in the CLI', () => withComputers(async ({ computers }) => {
  const a = await computers.create('p', 'agent-a');
  const started = Date.now();
  const result = await computers.exec(a.id, ['sleep', '60'], { timeoutMs: 1_000 });
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started < 15_000);
  assert.doesNotMatch((await computers.exec(a.id, ['ps', '-o', 'args'])).stdout, /sleep 60/);
}));

test('a missing image is reported and never pulled', () => withComputers(async ({ computers }) => {
  await assert.rejects(computers.create('p', 'agent-a'), /computer_image_missing/);
  assert.equal(computers.list().length, 0);
}, { image: 'optchat-absent-image:never' }));

test('invalid names and argv are refused before docker runs', () => withComputers(async ({ computers }) => {
  await assert.rejects(computers.create('p', '../a'), /invalid_request/);
  const a = await computers.create('p', 'agent-a');
  await assert.rejects(computers.exec(a.id, []), /invalid_request/);
  await assert.rejects(computers.exec(a.id, ['echo', 'a\0b']), /invalid_request/);
}));
