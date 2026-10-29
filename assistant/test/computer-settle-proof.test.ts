import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

type Entry = { id: string; owner: string; status: string };
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const failure = { code: 1, stdout: '', stderr: 'secret docker diagnostic' };
const OWNER_ID_FORMAT = '{{.Id}}|{{index .Config.Labels "optchat.computer.owner"}}';

/** A Docker fake that can inspect by name and by immutable ID, report `removing`, and hold `rm` open. */
function fixture() {
  const containers = new Map<string, Entry>();
  const failures = new Set<string>();
  const calls: string[][] = [];
  const hold: { rm?: Promise<'completed'>; entered?: () => void } = {};
  const find = (ref: string) => [...containers].find(([name, entry]) => name === ref || entry.id === ref);
  const docker: DockerRunner = async args => {
    calls.push([...args]);
    const ref = args.at(-1)!;
    if (args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1]!;
      containers.set(name, { id: String(containers.size + 1).padStart(64, 'c'), owner: 'owner', status: 'running' });
      return ok();
    }
    if (args[0] === 'ps') {
      if (failures.has('ps')) return failure;
      const idFormat = args.includes('{{.ID}}');
      const filtered = args.includes('--filter');
      return ok([...containers].filter(([, c]) => !filtered || c.owner === 'owner').map(([name, c]) => idFormat ? c.id : name).join('\n'));
    }
    if (args[0] === 'inspect') {
      if (failures.has(`inspect:${ref}`)) return failure;
      const found = find(ref);
      if (!found) return failure;
      const [, c] = found;
      const format = args[args.indexOf('--format') + 1];
      if (format === OWNER_ID_FORMAT) return ok(`${c.id}|${c.owner}`);
      if (format === '{{.Id}}|{{.State.Status}}') return ok(`${c.id}|${c.status}`);
      return ok(`${c.owner}|${c.status}`);
    }
    if (args[0] === 'rm') {
      if (hold.rm) { hold.entered?.(); if (await hold.rm === 'completed') return ok(); }
      if (failures.has(`rm:${ref}`)) return failure;
      const found = find(ref);
      if (!found) return failure;
      containers.delete(found[0]);
      return ok();
    }
    throw new Error(`unexpected ${args[0]}`);
  };
  const manager = new ComputerManager({ databasePath: ':memory:', owner: 'owner', image: 'image', operatorAuthority: {}, docker });
  return { manager, containers, failures, calls, hold };
}

test('a failed destroy can be retried once inspecting its immutable ID shows the container is not being removed', async () => {
  const f = fixture();
  try {
    const a = await f.manager.create('p', 'a');
    const id = f.containers.get(a.container)!.id;
    f.failures.add(`rm:${id}`);
    await assert.rejects(f.manager.destroy(a.id), /computer_remove_failed/);
    f.failures.clear();
    await f.manager.destroy(a.id);
    assert.deepEqual(f.manager.list(), []);
    assert.deepEqual(f.calls.filter(call => call[0] === 'rm').map(call => call.at(-1)), [id, id]);
  } finally { f.manager.close(); }
});

test('a retry is refused while the immutable ID is still being removed or its state cannot be inspected', async () => {
  const f = fixture();
  try {
    const a = await f.manager.create('p', 'a');
    const entry = f.containers.get(a.container)!;
    f.failures.add(`rm:${entry.id}`);
    await assert.rejects(f.manager.destroy(a.id), /computer_remove_failed/);
    entry.status = 'removing';
    await assert.rejects(f.manager.destroy(a.id), /computer_transition/);
    await assert.rejects(f.manager.cleanup(), /computer_transition/);
    entry.status = 'running';
    f.failures.add(`inspect:${entry.id}`); f.failures.add('ps');
    await assert.rejects(f.manager.destroy(a.id), /computer_transition/);
    assert.equal(f.manager.get(a.id).state, 'removing');
    f.failures.clear();
    await f.manager.destroy(a.id);
    assert.deepEqual(f.manager.list(), []);
  } finally { f.manager.close(); }
});

test('an overlapping destroy is refused while the first still holds its reservation, and the first cannot finish after a takeover', async () => {
  const f = fixture();
  try {
    const a = await f.manager.create('p', 'a');
    const entry = f.containers.get(a.container)!;
    let release!: (value: 'completed') => void, entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    f.hold.rm = new Promise<'completed'>(resolve => { release = resolve; }); f.hold.entered = entered;
    const first = f.manager.destroy(a.id); await reached;
    entry.status = 'removing';
    await assert.rejects(f.manager.destroy(a.id), /computer_transition/);
    // The earlier daemon operation settles: the container is gone, so a later destroy takes the stale reservation over.
    f.containers.delete(a.container); delete f.hold.rm;
    await f.manager.destroy(a.id);
    assert.deepEqual(f.manager.list(), []);
    release('completed');
    await assert.rejects(first, /computer_transition/);
  } finally { f.manager.close(); }
});

test('a failed owner cleanup can be retried, but not while another cleanup is in flight', async () => {
  const f = fixture();
  try {
    const a = await f.manager.create('p', 'a'); const b = await f.manager.create('p', 'b');
    const entryB = f.containers.get(b.container)!;
    f.failures.add(`rm:${entryB.id}`);
    await assert.rejects(f.manager.cleanup(), { message: 'computer_cleanup_failed: 1 container(s) require retry or inspection' });
    assert.deepEqual(f.manager.list().map(c => c.id), [b.id]);
    await assert.rejects(f.manager.create('p', 'c'), /computer_cleanup_active/);
    entryB.status = 'removing';
    await assert.rejects(f.manager.cleanup(), /computer_transition/);
    entryB.status = 'running'; f.failures.clear();
    assert.equal(await f.manager.cleanup(), 1);
    assert.deepEqual(f.manager.list(), []);
    assert.equal(f.containers.has(a.container), false);
    await f.manager.create('p', 'c');
  } finally { f.manager.close(); }
});

test('a second cleanup is refused while the first holds the owner reservation with nothing proven settled', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-settle-'));
  let entered!: () => void, release!: () => void, listings = 0;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const docker: DockerRunner = async args => {
    if (args[0] === 'ps' && ++listings === 1) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
    return args[0] === 'inspect' ? failure : ok();
  };
  const options = { databasePath: join(dir, 'db'), owner: 'owner', image: 'image', operatorAuthority: {}, docker };
  const a = new ComputerManager(options), b = new ComputerManager(options);
  try {
    await a.create('p', 'a');
    const first = a.cleanup(); await reached;
    await assert.rejects(b.cleanup(), /computer_cleanup_active/);
    release();
    assert.equal(await first, 0);
    assert.equal(await b.cleanup(), 0);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});
