import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/store.ts';
import { lockProfile, ProfileBusyError } from '../src/profiles.ts';
import { removeDir } from './support.ts';

test('a failed file flush preserves the previous state and a subsequent write recovers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flush-'));
  try {
    const file = join(dir, 'state.json'), failure = new Error('injected file flush failure');
    atomicWrite(file, 'previous committed value');
    const flush = mock.method(fs, 'fsyncSync', () => { throw failure; });
    syncBuiltinESMExports();
    assert.throws(() => atomicWrite(file, 'uncommitted replacement'), error => error === failure);
    assert.equal(readFileSync(file, 'utf8'), 'previous committed value');
    flush.mock.restore(); syncBuiltinESMExports();
    atomicWrite(file, 'recovered');
    assert.equal(readFileSync(file, 'utf8'), 'recovered');
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); removeDir(dir); }
});

const windowsLock = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

test('on Windows a rename refused while another process briefly holds the file is retried, and a lasting refusal still fails', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-rename-'));
  const realRename = fs.renameSync;
  try {
    const file = join(dir, 'state.json');
    atomicWrite(file, 'previous committed value');
    // Defender or the indexer opens a just-written file without delete sharing: rename then fails with EPERM/EACCES/EBUSY for a moment.
    let refusals = 0;
    mock.method(fs, 'renameSync', (from: string, to: string) => {
      if (refusals < 3) { refusals++; throw windowsLock(['EPERM', 'EACCES', 'EBUSY'][refusals - 1]); }
      return realRename(from, to);
    });
    syncBuiltinESMExports();
    atomicWrite(file, 'replacement');
    assert.equal(refusals, 3);
    assert.equal(readFileSync(file, 'utf8'), 'replacement');
    assert.deepEqual(readdirSync(dir), ['state.json']);
    mock.restoreAll();
    mock.method(fs, 'renameSync', () => { throw windowsLock('EPERM'); });
    syncBuiltinESMExports();
    const started = Date.now();
    assert.throws(() => atomicWrite(file, 'never committed'), (error: NodeJS.ErrnoException) => error.code === 'EPERM');
    assert.ok(Date.now() - started < 5_000, 'the retry is bounded');
    assert.equal(readFileSync(file, 'utf8'), 'replacement');
  } finally { mock.restoreAll(); syncBuiltinESMExports(); removeDir(dir); }
});

test('a profile lock is released by the OS when its owning process is killed', { timeout: 20_000 }, async () => {
  // macOS's default TMPDIR can exceed the Unix socket path limit.
  const dir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'oc-crash-'));
  const moduleUrl = new URL('../src/profiles.ts', import.meta.url).href;
  const script = `import { lockProfile } from ${JSON.stringify(moduleUrl)}; await lockProfile(process.argv[1], 'child owner'); process.send('ready');`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '', exited = false;
  child.stderr!.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
  const exit = once(child, 'exit').then(() => { exited = true; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  let unlock: (() => Promise<void>) | undefined;
  try {
    await Promise.race([
      once(child, 'message').then(([message]) => { assert.equal(message, 'ready'); }),
      exit.then(() => { throw new Error(`Lock owner exited before readiness: ${stderr}`); }),
    ]);
    await assert.rejects(lockProfile(dir, 'competitor'), error => error instanceof ProfileBusyError && error.owner === 'child owner');
    child.kill('SIGKILL'); await exit;
    unlock = await lockProfile(dir, 'replacement owner');
    await assert.rejects(lockProfile(dir, 'another writer'), /replacement owner/);
  } finally {
    clearTimeout(timeout);
    // `exit` rejects if the child failed to spawn; cleanup below must still run.
    if (!exited) { child.kill('SIGKILL'); await exit.catch(() => {}); }
    await unlock?.(); removeDir(dir);
  }
});
