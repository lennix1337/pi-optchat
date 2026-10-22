import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeDir, tempDir, withTempDir } from './support.ts';

test('a test process leaves nothing in the temp dir: not a forgotten dir, not one rewritten after its removal, not a worker thread\'s', () => {
  const temp = mkdtempSync(join(tmpdir(), 'optchat-support-'));
  // Like Pi's image-resize worker: started from a file, so it loads --import again, and terminated, so it never sees 'exit'.
  const worker = join(temp, 'worker.mjs');
  writeFileSync(worker, "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('up'); setInterval(() => {}, 1000);");
  const script = `
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const { Worker } = require('node:worker_threads');
    mkdtempSync(join(tmpdir(), 'optchat-forgotten-'));
    const late = mkdtempSync(join(tmpdir(), 'optchat-late-'));
    rmSync(late, { recursive: true });
    setTimeout(() => { mkdirSync(late); writeFileSync(join(late, 'auth.json'), '{}'); }, 10);
    const worker = new Worker(${JSON.stringify(worker)});
    worker.on('message', () => worker.terminate());`;
  try {
    execFileSync(process.execPath, ['--import', 'tsx', '--import', new URL('./support.ts', import.meta.url).href, '-e', script],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp } });
    assert.deepEqual(readdirSync(temp).filter(name => name.startsWith('optchat-')), []);
  } finally { removeDir(temp); }
});

test('tempDir closes its directory, and withTempDir removes it after a return, a throw, a resolved promise and a rejected one', async () => {
  const fixture = tempDir('optchat-support-fixture-');
  assert.ok(existsSync(fixture.dir));
  fixture.close();
  assert.equal(existsSync(fixture.dir), false);

  const seen: string[] = [];
  const keep = (dir: string) => { seen.push(dir); writeFileSync(join(dir, 'file'), 'x'); return dir; };
  assert.equal(withTempDir('optchat-support-sync-', keep), seen[0]);
  assert.throws(() => withTempDir('optchat-support-throw-', dir => { keep(dir); throw new Error('sync failure'); }), /sync failure/);
  assert.equal(await withTempDir('optchat-support-async-', async dir => keep(dir)), seen[2]);
  await assert.rejects(withTempDir('optchat-support-reject-', async dir => { keep(dir); throw new Error('async failure'); }), /async failure/);
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.filter(existsSync), []);
});
