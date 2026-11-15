import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { commands, TEST_CONCURRENCY, verify, withSuiteLock } from '../scripts/verify.mjs';

const moduleUrl = new URL('../scripts/verify.mjs', import.meta.url).href;
function contender(port, cwd) {
  const script = `import { withSuiteLock } from ${JSON.stringify(moduleUrl)};
    await withSuiteLock(async port => {
      process.send({kind:'entered',port});
      await new Promise(resolve => process.once('message', resolve));
    }, {port:${port}, waiting:()=>process.send({kind:'waiting'})});
    process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = [];
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.on('message', message => messages.push(message));
  const exit = once(child, 'exit').then(([code, signal]) => ({ code, signal, stderr }));
  async function next(kind) {
    const message = messages.find(message => kind === undefined || message.kind === kind);
    if (message) return message;
    return Promise.race([
      new Promise(resolve => { const receive = message => { if (kind === undefined || message.kind === kind) { child.off('message', receive); resolve(message); } }; child.on('message', receive); }),
      exit.then(result => { throw new Error(`Fixture exited before ${kind}: ${JSON.stringify(result)}`); }),
    ]);
  }
  return { child, messages, next, exit };
}

test('two independent checkouts cannot execute suite phases together', { timeout: 15000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'verify-checkout-'));
  const owner = contender(0);
  let queued;
  try {
    const { port } = await owner.next('entered');
    queued = contender(port, cwd);
    assert.equal((await queued.next()).kind, 'waiting', 'a second suite must wait, not enter its phases');
    assert.equal(queued.messages.some(message => message.kind === 'entered'), false);
    owner.child.send('release');
    assert.equal((await owner.exit).code, 0);
    await queued.next('entered');
    queued.child.send('release');
    assert.equal((await queued.exit).code, 0);
  } finally {
    owner.child.kill(); queued?.child.kill();
    await Promise.all([owner.exit, queued?.exit]);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the OS releases a killed owner without a stale file or timeout lease', { timeout: 15000 }, async () => {
  const owner = contender(0);
  let queued;
  try {
    const { port } = await owner.next('entered');
    queued = contender(port);
    await queued.next('waiting');
    owner.child.kill('SIGKILL');
    await owner.exit;
    await queued.next('entered');
    queued.child.send('release');
    assert.equal((await queued.exit).code, 0);
  } finally {
    owner.child.kill(); queued?.child.kill();
    await Promise.all([owner.exit, queued?.exit]);
  }
});

test('an exception releases the lock and propagates', async () => {
  const port = await withSuiteLock(async port => port, { port: 0 });
  await assert.rejects(withSuiteLock(async () => { throw new Error('phase failed'); }, { port }), /phase failed/);
  assert.equal(await withSuiteLock(async () => 'next', { port }), 'next');
});

test('an unrelated port owner fails clearly instead of waiting forever', async () => {
  const server = createServer(socket => socket.end('different service\n'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await assert.rejects(withSuiteLock(async () => assert.fail('must not run'), { port: server.address().port }), /not a pi-optchat suite lock/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('test commands keep the complete original glob and loader flags with a bounded concurrency', () => {
  const all = commands(false);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0].slice(1), ['--noEmit']);
  assert.equal(TEST_CONCURRENCY, Math.min(4, Math.max(1, availableParallelism() - 1)));
  assert.deepEqual(commands(true, ['--test-shard=1/2']), [[
    '--experimental-transform-types', '--import', './test/support.ts', '--test', `--test-concurrency=${TEST_CONCURRENCY}`, '--test-shard=1/2', 'test/*.test.ts',
  ]]);
  assert.deepEqual(all[1], commands(true)[0]);
  const recipes = JSON.parse(readFileSync(new URL('../.pi/checks.json', import.meta.url), 'utf8'));
  assert.deepEqual(recipes.checks.unit.argv, ['node', 'scripts/verify.mjs', '--test-only'], 'the official full-suite recipe must join the same lock');
});

test('a failed check stops verification; a failed suite keeps its exit code', async () => {
  const calls = [];
  assert.equal(await verify(false, [], async args => { calls.push(args); return 7; }), 7);
  assert.equal(calls.length, 1);
  assert.equal(await verify(true, [], async () => 9), 9);
});
