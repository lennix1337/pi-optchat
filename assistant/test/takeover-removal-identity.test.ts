import assert from 'node:assert/strict';
import { test } from 'node:test';
import { removeComputer } from '../src/computer/removal.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

const id = 'a'.repeat(64), replacement = 'b'.repeat(64);
test('renamed human container is removed by immutable ID without touching name replacement', async () => {
  const calls: string[][] = [];
  const docker: DockerRunner = async args => {
    calls.push([...args]);
    if (args[0] === 'inspect' && args.at(-1) === id) return { code: 0, stdout: `${id}|owner|profile|agent`, stderr: '' };
    if (args[0] === 'inspect') return { code: 0, stdout: `${replacement}|owner|profile|agent`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  assert.equal(await removeComputer(docker, 'owner', 'old-name', true, id, { profile: 'profile', agent: 'agent' }), 'removed');
  assert.equal(calls[0]?.at(-1), id);
  assert.deepEqual(calls.at(-1), ['rm', '--force', id]);
  assert.equal(calls.some(args => args.includes(replacement)), false);
});

test('absent name is not proof of expected ID absence and labels must match', async () => {
  const docker: DockerRunner = async args => args[0] === 'ps'
    ? { code: 0, stdout: id, stderr: '' }
    : { code: 1, stdout: '', stderr: '' };
  assert.equal(await removeComputer(docker, 'owner', 'old-name', true, id, { profile: 'profile', agent: 'agent' }), 'failed');
  const mismatch: DockerRunner = async () => ({ code: 0, stdout: `${id}|owner|other|agent`, stderr: '' });
  assert.equal(await removeComputer(mismatch, 'owner', 'old-name', true, id, { profile: 'profile', agent: 'agent' }), 'foreign');
});
