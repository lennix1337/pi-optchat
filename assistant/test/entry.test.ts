import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const secret = 'ENTRY-SECRET-987';
const answer = 'PRIVATE-ANSWER-987';
const profileId = 'entry-profile';
const context = (sourceEventId: string) => ({ sessionId: 'session', channelId: 'channel', runId: 'run', sourceEventId, evidenceReference: 'reference' });
const task = { version: 1, profileId, taskId: 'task-id', title: 'task', status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: 'source-1' };

async function port(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const number = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return number;
}
function child(config: string, web = false) {
  const process = spawn(processExec(), [main, '--config', config, ...(web ? ['--web'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; process.stdout!.on('data', data => { output += data; }); process.stderr!.on('data', data => { output += data; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => process.once('exit', (code, signal) => resolve({ code, signal })));
  return { process, exited, output: () => output };
}
function processExec() { return process.execPath; }
/** On Windows a just-exited child can keep a fixture handle briefly, so the first rmdir fails EPERM/EBUSY even though the
 * owner has FullControl and no process remains (observed 2026-10-28; same cause as the root suite's removeDir). Bounded: 5.5 s. */
function removeFixture(path: string) {
  for (let attempt = 1; ; attempt++) {
    try { return rmSync(path, { recursive: true, force: true }); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === 10 || !(code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
    }
  }
}
function privateTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'
$a=[System.Security.AccessControl.DirectorySecurity]::new()
$a.SetAccessRuleProtection($true,$false)
foreach($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) {
 $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
[System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($env:ENTRY_FIXTURE),$a)`;
    const result = spawnSync('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ENTRY_FIXTURE: dir }, timeout: 10000 });
    if (result.status !== 0) { removeFixture(dir); throw new Error('Could not secure disposable entry fixture'); }
  }
  return dir;
}
async function ready(c: ReturnType<typeof child>) {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      const check = (data: Buffer) => { if (data.toString().includes('Assistant listening:')) { c.process.stdout!.off('data', check); resolve(); } };
      c.process.stdout!.on('data', check);
      c.exited.then(() => reject(new Error('Exited before readiness')));
    }),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Readiness timeout')), 8000); timer.unref(); }),
  ]);
}
async function stop(c: ReturnType<typeof child>) {
  c.process.kill('SIGTERM');
  const timer = setTimeout(() => c.process.kill('SIGKILL'), 5000); timer.unref();
  try { return await c.exited; } finally { clearTimeout(timer); }
}

test('help is side-effect free; invalid configs cannot open a database', async () => {
  const dir = privateTemp('entry-invalid-');
  try {
    const help = spawnSync(process.execPath, [main, '--help'], { cwd: dir, encoding: 'utf8', timeout: 5000 });
    assert.equal(help.status, 0); assert.match(help.stdout, /manual/i); assert.match(help.stdout, /databasePath/); assert.deepEqual(readdirSync(dir), []);
    const db = join(dir, 'never.db'), config = join(dir, 'config.json');
    const base = { version: 1, profileId, databasePath: db, endpoint: `http://127.0.0.1:${await port()}`, token: secret };
    const invalid = ['{', JSON.stringify({ ...base, extra: true }), JSON.stringify({ ...base, version: 2 }), JSON.stringify({ ...base, endpoint: 'http://localhost:80' }), JSON.stringify({ ...base, endpoint: 'http://127.0.0.1:65536' }), JSON.stringify({ ...base, databasePath: ':memory:' }), JSON.stringify({ ...base, databasePath: 'relative.db' }), JSON.stringify({ ...base, profileId: ' ' }), JSON.stringify({ ...base, token: 'bad token' }), JSON.stringify(base) + ' '.repeat(8193)];
    for (const data of invalid) {
      writeFileSync(config, data);
      const result = spawnSync(process.execPath, [main, '--config', config], { cwd: dir, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 1); assert.match(result.stderr, /configuration/i); assert.doesNotMatch(result.stderr + result.stdout, new RegExp(secret)); assert.equal(existsSync(db), false);
    }
  } finally { removeFixture(dir); }
});

test('configuration guards reject disposable mutations', { timeout: 180000 }, () => {
  const root = privateTemp('entry-mutations-');
  const assistant = fileURLToPath(new URL('../', import.meta.url));
  const variants: [string, string][] = [
    ['count > 8192', 'false'],
    ["Object.keys(v).sort().join(',') !== 'databasePath,endpoint,profileId,token,version'", 'false'],
    ['v.version !== 1', 'false'],
    ['!v.profileId.trim()', 'false'],
    ['!isAbsolute(v.databasePath)', 'false'],
    ["!/^[\\x21-\\x7e]+$/.test(v.token)", 'false'],
    ["!/^http:\\/\\/127\\.0\\.0\\.1:[0-9]+$/.test(v.endpoint)", 'false'],
    ['port > 65535', 'false'],
  ];
  try {
    for (const [index, [before, after]] of variants.entries()) {
      const copy = join(root, String(index));
      mkdirSync(join(copy, 'test'), { recursive: true });
      cpSync(join(assistant, 'src'), join(copy, 'src'), { recursive: true });
      cpSync(join(assistant, 'test', 'entry.test.ts'), join(copy, 'test', 'entry.test.ts'));
      cpSync(join(assistant, 'package.json'), join(copy, 'package.json'));
      const sourcePath = join(copy, 'src', 'main.ts');
      const source = readFileSync(sourcePath, 'utf8'); assert.ok(source.includes(before), before);
      writeFileSync(sourcePath, source.replace(before, after));
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=help is side-effect free', join(copy, 'test', 'entry.test.ts')], { env, encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 1, `${before}: ${result.stderr}`);
      assert.match(result.stdout, /AssertionError/, before);
    }
  } finally { removeFixture(root); }
});

test('shutdown bounds active connections', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const dir = privateTemp('entry-shutdown-');
  const config = join(dir, 'config.json'), number = await port();
  writeFileSync(config, JSON.stringify({ version: 1, profileId, databasePath: join(dir, 'store.db'), endpoint: `http://127.0.0.1:${number}`, token: secret }));
  const running = child(config);
  try {
    await ready(running);
    const socket = createConnection(number, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('POST /v1/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ' + secret + '\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
    const result = await stop(running);
    assert.deepEqual(result, { code: 0, signal: null });
    socket.destroy();
  } finally {
    if (running.process.exitCode === null && running.process.signalCode === null) await stop(running);
    removeFixture(dir);
  }
});

test('manual process persists authenticated state and handles bind collision', { timeout: 30000 }, async () => {
  const dir = privateTemp('entry-journey-');
  const config = join(dir, 'config.json'), db = join(dir, 'store.db');
  const endpoint = `http://127.0.0.1:${await port()}`;
  writeFileSync(config, JSON.stringify({ version: 1, profileId, databasePath: db, endpoint, token: secret }));
  let running: ReturnType<typeof child> | undefined;
  try {
    running = child(config); await ready(running);
    const request = (path: string, body?: unknown, token = secret) => fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) });
    assert.equal((await request('/', undefined, 'wrong')).status, 401, 'web is off by default');
    assert.equal((await request('/v1/tasks', undefined, 'wrong')).status, 401);
    assert.equal((await request('/v1/tasks', { task, context: context('source-1') })).status, 200);
    assert.equal((await request('/v1/tasks/task-id/transition', { expectedRevision: 1, nextStatus: 'working', context: context('source-2') })).status, 200);
    assert.equal((await request('/v1/tasks/task-id/transition', { expectedRevision: 2, nextStatus: 'needs_input', context: context('source-3') })).status, 200);
    assert.equal((await request('/v1/tasks/task-id/respond', { response: { version: 1, profileId, taskId: 'task-id', revision: 3, inputRevision: 2, text: answer }, context: context('source-4') })).status, 200);
    const collision = child(config); const result = await Promise.race([collision.exited, new Promise<never>((_, reject) => { const t = setTimeout(() => { collision.process.kill(); reject(new Error('Collision timeout')); }, 5000); t.unref(); })]);
    assert.equal(result.code, 1); assert.match(collision.output(), /address in use/i); assert.doesNotMatch(collision.output(), new RegExp(secret));
    const stopped = await stop(running);
    if (process.platform !== 'win32') assert.deepEqual(stopped, { code: 0, signal: null });
    assert.doesNotMatch(running.output(), new RegExp(`${secret}|${answer}`));
    running = child(config, true); await ready(running);
    const page = await request('/', undefined, 'wrong');
    assert.equal(page.status, 200); assert.match(await page.text(), /Caixa de trabalho/);
    assert.equal((await request('/web/api/tasks')).status, 401, 'native bearer is not web authentication');
    const restored = await (await request('/v1/tasks/task-id')).json() as typeof task;
    assert.equal(restored.profileId, profileId); assert.equal(restored.status, 'working'); assert.equal(restored.revision, 4);
  } finally {
    if (running && running.process.exitCode === null && running.process.signalCode === null) await stop(running);
    if (running) assert.doesNotMatch(running.output(), new RegExp(`${secret}|${answer}`));
    removeFixture(dir);
  }
});
