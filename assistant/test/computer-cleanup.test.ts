import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputerManager } from '../src/computer/manager.ts';
import type { DockerRunner } from '../src/computer/docker.ts';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const failure = { code: 1, stdout: '', stderr: 'secret docker diagnostic' };

function fixture() {
  const containers = new Map<string, { id: string; owner: string }>();
  const calls: string[][] = [];
  const failures = new Set<string>();
  const docker: DockerRunner = async args => {
    calls.push([...args]);
    const name = args.at(-1)!;
    if (args[0] === 'run') {
      const container = args[args.indexOf('--name') + 1]!;
      containers.set(container, { id: String(containers.size + 1).padStart(64, 'a'), owner: 'owner' });
      return ok();
    }
    if (args[0] === 'ps') {
      if (failures.has('ps')) return failure;
      const filtered = args.includes('--filter');
      return ok([...containers].filter(([, c]) => !filtered || c.owner === 'owner' || failures.has('foreign-listed')).map(([n]) => n).join('\n'));
    }
    if (args[0] === 'inspect') {
      if (failures.has(`inspect:${name}`)) return failure;
      const c = containers.get(name);
      if (!c) return failure;
      return ok(args.includes('{{.Id}}|{{index .Config.Labels "optchat.computer.owner"}}') ? `${c.id}|${c.owner}` : `${c.owner}|running`);
    }
    if (args[0] === 'rm') {
      if (failures.has(`rm:${name}`)) return failure;
      const entry = [...containers].find(([n, c]) => n === name || c.id === name);
      if (!entry) return failure;
      containers.delete(entry[0]);
      return ok();
    }
    throw new Error(`unexpected ${args[0]}`);
  };
  const manager = new ComputerManager({ databasePath: ':memory:', owner: 'owner', image: 'image', operatorAuthority: {}, docker });
  return { manager, containers, calls, failures };
}

test('partial removal preserves failed row and reports a redacted failure', async () => {
  const f = fixture();
  try {
    const a = await f.manager.create('p', 'a'); const b = await f.manager.create('p', 'b');
    f.failures.add(`rm:${f.containers.get(b.container)!.id}`); f.failures.add(`rm:${b.container}`);
    await assert.rejects(f.manager.cleanup(), { message: 'computer_cleanup_failed: 1 container(s) require retry or inspection' });
    assert.deepEqual(f.manager.list().map(c => c.id), [b.id]);
    assert.equal(f.containers.has(a.container), false); assert.equal(f.containers.has(b.container), true);
  } finally { f.manager.close(); }
});

test('listing failure retains records', async () => {
  const f = fixture();
  try { const a = await f.manager.create('p', 'a'); f.failures.add('ps');
    await assert.rejects(f.manager.cleanup(), /computer_cleanup_failed/); assert.equal(f.manager.get(a.id).id, a.id);
  } finally { f.manager.close(); }
});

test('inspect uncertainty retains records', async () => {
  const f = fixture();
  try { const a = await f.manager.create('p', 'a'); f.failures.add(`inspect:${a.container}`);
    await assert.rejects(f.manager.cleanup(), /computer_cleanup_failed/); assert.equal(f.manager.get(a.id).id, a.id);
  } finally { f.manager.close(); }
});

test('foreign replacement is preserved with its row', async () => {
  const f = fixture();
  try { const a = await f.manager.create('p', 'a'); f.containers.get(a.container)!.owner = 'foreign';
    await assert.rejects(f.manager.cleanup(), /computer_cleanup_failed/); assert.equal(f.manager.get(a.id).id, a.id);
    assert.equal(f.containers.has(a.container), true); assert.equal(f.calls.some(c => c[0] === 'rm'), false);
  } finally { f.manager.close(); }
});

test('absent rows are deleted and successful count is numeric', async () => {
  const f = fixture();
  try { const a = await f.manager.create('p', 'a'); await f.manager.create('p', 'b'); f.containers.delete(a.container);
    assert.equal(await f.manager.cleanup(), 1); assert.deepEqual(f.manager.list(), []);
  } finally { f.manager.close(); }
});

test('untracked foreign listing is ignored without removing it', async () => {
  const f = fixture();
  try {
    await f.manager.create('p', 'a');
    f.containers.set('foreign', { id: 'b'.repeat(64), owner: 'foreign' });
    f.failures.add('foreign-listed');
    assert.equal(await f.manager.cleanup(), 1);
    assert.equal(f.containers.has('foreign'), true);
    assert.equal(f.calls.some(c => c[0] === 'rm' && (c.at(-1) === 'foreign' || c.at(-1) === 'b'.repeat(64))), false);
  } finally { f.manager.close(); }
});

test('destroy retains a row when inspect fails for a listed container', async () => {
  const f = fixture();
  try {
    const a = await f.manager.create('p', 'a'); f.failures.add(`inspect:${a.container}`);
    await assert.rejects(f.manager.destroy(a.id), /computer_remove_failed/);
    assert.equal(f.manager.get(a.id).id, a.id);
  } finally { f.manager.close(); }
});

test('destroy confirms absence via listing and retains row on listing failure', async () => {
  const f = fixture();
  try {
    const a = await f.manager.create('p', 'a'); f.containers.delete(a.container); f.failures.add('ps');
    await assert.rejects(f.manager.destroy(a.id), /computer_remove_failed/);
    assert.equal(f.manager.get(a.id).id, a.id);
    f.failures.delete('ps'); await f.manager.destroy(a.id);
    assert.deepEqual(f.manager.list(), []);
  } finally { f.manager.close(); }
});

test('destroy removes by immutable ID and refuses a foreign replacement', async () => {
  const f = fixture();
  try {
    const a = await f.manager.create('p', 'a'); const id = f.containers.get(a.container)!.id;
    f.containers.get(a.container)!.owner = 'foreign';
    await assert.rejects(f.manager.destroy(a.id), /computer_conflict/);
    assert.equal(f.manager.get(a.id).id, a.id);
    f.containers.get(a.container)!.owner = 'owner';
    await f.manager.destroy(a.id);
    assert.ok(f.calls.some(c => c[0] === 'rm' && c.at(-1) === id));
    assert.deepEqual(f.manager.list(), []);
  } finally { f.manager.close(); }
});

test('a create that a dead process left in transition is recovered by the next process cleanup', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'computer-orphan-'));
  const databasePath = join(dir, 'computer.sqlite');
  const f = fixture();
  let dockerUp = false;
  const docker: DockerRunner = async (args, options) => dockerUp ? f.manager['docker'](args, options) : failure;
  const crashed = new ComputerManager({ databasePath, owner: 'owner', image: 'image', operatorAuthority: {}, docker });
  try {
    await assert.rejects(crashed.create('p', 'executor'), { message: 'computer_start_failed' });
    crashed.close(); // the process dies here; its reservation stays in the database
    dockerUp = true;
    const next = new ComputerManager({ databasePath, owner: 'owner', image: 'image', operatorAuthority: {}, docker });
    try {
      await next.cleanup();
      assert.deepEqual(next.list(), []);
      const computer = await next.create('p', 'executor');
      assert.equal(computer.state, 'ready');
    } finally { next.close(); }
  } finally { f.manager.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a transition held by this live process is never taken over by cleanup', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const inner = f.manager['docker'];
  f.manager['docker'] = async (args: string[], options?: unknown) => { if (args[0] === 'run') await gate; return inner(args, options); };
  try {
    const creating = f.manager.create('p', 'a');
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.manager.cleanup(), { message: 'computer_transition' });
    release();
    assert.equal((await creating).state, 'ready');
  } finally { f.manager.close(); }
});
