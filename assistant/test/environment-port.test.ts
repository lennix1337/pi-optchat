import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { EnvironmentRefused, planOpen, planRun } from '../src/environment/actions.ts';
import { createLocalEnvironment, localEnvironment, type Spawn } from '../src/environment/local.ts';
import { daemonEnvironment, loadOrCreateToken, startEnvironmentDaemon } from '../src/environment/daemon.ts';
import { dockerVia } from '../src/computer/docker.ts';
import { windowsToast } from '../src/notifications/task-notifier.ts';

function refusal(fn: () => unknown): string {
  try { fn(); } catch (error) { assert.ok(error instanceof EnvironmentRefused, `expected a refusal, got ${String(error)}`); return error.message; }
  assert.fail('the request was allowed');
}

// ---- The allow-list ------------------------------------------------------------------------------

test('only the named actions exist; unknown names, prototype keys and non-objects are refused before a process', () => {
  for (const action of ['shell', '__proto__', 'constructor', 'toString', '']) assert.equal(refusal(() => planRun({ action, args: ['ps'] })), 'unknown_action');
  assert.equal(refusal(() => planRun(null)), 'unknown_action');
  assert.equal(refusal(() => planRun(['docker'])), 'unknown_action');
  assert.equal(refusal(() => planOpen({ action: 'docker', args: ['ps'] })), 'unknown_action', 'a run action is not a stream');
  assert.equal(refusal(() => planRun({ action: 'docker_stream', container: 'x', program: 'socat-viewer' })), 'unknown_action');
});

test('docker: the manager\'s subcommands are allowed; anything else, and host-escaping flags, are refused', () => {
  const allowed = [['info', '--format', '{{json .}}'], ['image', 'inspect', '--format', '{{.Id}}', 'img'], ['inspect', '--type', 'container', 'c1'], ['ps', '--all'],
    ['pause', 'c1'], ['unpause', 'c1'], ['start', 'c1'], ['rm', '--force', 'c1'], ['exec', '--user', '1000:1000', 'c1', 'sh', '-c', 'true'],
    ['run', '--detach', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--ipc', 'private', '--tmpfs', '/work:rw,nosuid', 'img', 'tail', '-f', '/dev/null']];
  for (const args of allowed) assert.deepEqual(planRun({ action: 'docker', args }).args, args);
  for (const args of [['system', 'prune'], ['image', 'rm', 'img'], ['volume', 'ls'], ['--privileged', 'ps'], ['login'], ['']]) {
    assert.equal(refusal(() => planRun({ action: 'docker', args })), 'docker_subcommand_refused', args.join(' '));
  }
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['run', '--privileged', 'img'] })), 'docker_flag_refused');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['run', '--cap-add', 'SYS_ADMIN', 'img'] })), 'docker_flag_refused');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['run', '-v', '/:/host', 'img'] })), 'docker_flag_refused');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['run', '--volume=/:/host', 'img'] })), 'docker_flag_refused');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['run', '--mount', 'type=bind,src=/,dst=/h', 'img'] })), 'docker_flag_refused');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['run', '--device', '/dev/sda', 'img'] })), 'docker_flag_refused');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['run', '--pid', 'host', 'img'] })), 'docker_flag_refused');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['run', '--network', 'host', 'img'] })), 'docker_flag_refused');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['run', '--net=host', 'img'] })), 'docker_flag_refused');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['run', '--network=container:other', 'img'] })), 'docker_flag_refused');
});

test('docker: argv must be an array of bounded strings without NUL; the timeout has bounds', () => {
  assert.equal(refusal(() => planRun({ action: 'docker', args: 'ps' })), 'invalid_docker_args');
  assert.equal(refusal(() => planRun({ action: 'docker', args: [] })), 'invalid_docker_args');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['ps', 1] })), 'invalid_docker_args');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['ps', 'a\0b'] })), 'invalid_docker_args');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['ps', 'x'.repeat(4097)] })), 'invalid_docker_args');
  assert.equal(refusal(() => planRun({ action: 'docker', args: Array(257).fill('ps') })), 'invalid_docker_args');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['ps'], timeoutMs: 0 })), 'invalid_timeout');
  assert.equal(refusal(() => planRun({ action: 'docker', args: ['ps'], timeoutMs: 120_001 })), 'invalid_timeout');
  assert.equal(planRun({ action: 'docker', args: ['ps'] }).timeoutMs, 30_000);
  assert.equal(planRun({ action: 'docker', args: ['ps'], timeoutMs: 15_000 }).timeoutMs, 15_000);
});

test('toast: the text reaches the process only through its environment, never its argv; bounded and without NUL', () => {
  const plan = planRun({ action: 'toast', text: 'Tarefa "x"; rm -rf / $(id)' });
  assert.equal(plan.file, 'powershell.exe');
  assert.deepEqual(plan.env, { OPTCHAT_TOAST_TEXT: 'Tarefa "x"; rm -rf / $(id)' });
  assert.ok(!plan.args.join(' ').includes('rm -rf'), 'the text is not on the command line');
  assert.equal(refusal(() => planRun({ action: 'toast', text: 'x'.repeat(4001) })), 'invalid_toast_text');
  assert.equal(refusal(() => planRun({ action: 'toast', text: 'a\0b' })), 'invalid_toast_text');
  assert.equal(refusal(() => planRun({ action: 'toast' })), 'invalid_toast_text');
});

test('dpapi: only protect or unprotect, base64 data on stdin, never on the command line', () => {
  const plan = planRun({ action: 'dpapi', op: 'unprotect', data: 'AAEC/w==' });
  assert.equal(plan.stdin, 'unprotect AAEC/w==');
  assert.ok(!plan.args.some(arg => arg.includes('AAEC')), 'the key material is not in argv');
  assert.equal(refusal(() => planRun({ action: 'dpapi', op: 'delete', data: 'AA==' })), 'invalid_dpapi_op');
  assert.equal(refusal(() => planRun({ action: 'dpapi', op: 'protect', data: 'AA== ; calc' })), 'invalid_dpapi_data');
  assert.equal(refusal(() => planRun({ action: 'dpapi', op: 'protect', data: 42 })), 'invalid_dpapi_data');
});

test('streams: only the two viewer programs, with the exact argv they always used; the container must be a plain name', () => {
  assert.deepEqual(planOpen({ action: 'docker_stream', container: 'c1', program: 'socat-viewer' }).args, ['exec', '-i', 'c1', 'socat', '-', 'TCP:127.0.0.1:6088']);
  assert.deepEqual(planOpen({ action: 'docker_stream', container: 'c1', program: 'https-relay' }).args,
    ['exec', '--interactive', '--user', '1000:1000', '--workdir', '/work', 'c1', 'timeout', '-s', 'KILL', '150', 'node', '/opt/optchat/https-relay.mjs']);
  assert.equal(refusal(() => planOpen({ action: 'docker_stream', container: 'c1', program: 'sh' })), 'invalid_program');
  assert.equal(refusal(() => planOpen({ action: 'docker_stream', container: 'c1', program: 'toString' })), 'invalid_program');
  assert.equal(refusal(() => planOpen({ action: 'docker_stream', container: 'c1; rm -rf /', program: 'socat-viewer' })), 'invalid_container');
  assert.equal(refusal(() => planOpen({ action: 'docker_stream', container: '-it', program: 'socat-viewer' })), 'invalid_container');
  assert.equal(refusal(() => planOpen({ action: 'docker_stream', container: 'c1' })), 'invalid_program');
});

// ---- The local adapter, observed through a fake process -----------------------------------------

type FakeScript = { exit?: number | null; error?: Error; stdout?: string; stderr?: string; hang?: boolean };
function fakeSpawn(script: FakeScript) {
  const launches: { file: string; args: string[]; env?: Record<string, string | undefined>; stdin: string; killed: boolean }[] = [];
  const spawn: Spawn = (file, args, options) => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const record = { file, args, env: options.env as Record<string, string | undefined> | undefined, stdin: '', killed: false };
    launches.push(record);
    child.stdin = new Writable({ write(chunk, _encoding, done) { record.stdin += String(chunk); done(); } });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { record.killed = true; if (script.hang) setImmediate(() => child.emit('close', null)); return true; };
    setImmediate(() => {
      if (script.error) { child.emit('error', script.error); return; }
      if (script.stdout) (child.stdout as PassThrough).write(script.stdout);
      (child.stdout as PassThrough).end();
      if (script.stderr) (child.stderr as PassThrough).write(script.stderr);
      (child.stderr as PassThrough).end();
      if (!script.hang) child.emit('close', 'exit' in script ? script.exit : 0);
    });
    return child as unknown as ReturnType<Spawn>;
  };
  return { spawn, launches };
}

test('the local adapter starts the planned process with the exact file, argv, environment and stdin, and no shell', async () => {
  const fake = fakeSpawn({ stdout: 'listed', exit: 0 });
  const env = createLocalEnvironment({ spawn: fake.spawn });
  const result = await env.run({ action: 'docker', args: ['ps', '--all'] });
  assert.deepEqual(result, { code: 0, stdout: 'listed', stderr: '', uncertain: false });
  assert.equal(fake.launches.length, 1);
  assert.equal(fake.launches[0]!.file, 'docker');
  assert.deepEqual(fake.launches[0]!.args, ['ps', '--all']);
  assert.equal(fake.launches[0]!.stdin, '', 'stdin is closed');
});

test('a refused request never starts a process', async () => {
  const fake = fakeSpawn({ exit: 0 });
  const env = createLocalEnvironment({ spawn: fake.spawn });
  await assert.rejects(env.run({ action: 'docker', args: ['run', '--privileged', 'img'] }), EnvironmentRefused);
  await assert.rejects(env.run({ action: 'toast', text: 'x'.repeat(5000) }), EnvironmentRefused);
  assert.throws(() => env.open({ action: 'docker_stream', container: 'c1', program: 'bash' } as never), EnvironmentRefused);
  assert.equal(fake.launches.length, 0, 'no process was started for a refused request');
});

test('exit codes map to results as the docker runner always did: 125-127 and a killed or unstartable process are uncertain', async () => {
  const cases: [FakeScript, number, boolean][] = [
    [{ exit: 0 }, 0, false], [{ exit: 1 }, 1, false], [{ exit: 125 }, 125, true], [{ exit: 127 }, 127, true],
    [{ exit: null }, 1, true], [{ error: new Error('spawn docker ENOENT') }, 1, true],
  ];
  for (const [script, code, uncertain] of cases) {
    const result = await createLocalEnvironment({ spawn: fakeSpawn(script).spawn }).run({ action: 'docker', args: ['ps'] });
    assert.equal(result.code, code, JSON.stringify(script));
    assert.equal(result.uncertain, uncertain, JSON.stringify(script));
  }
});

test('a one-shot action that outlives its timeout is killed and reported uncertain', async () => {
  const fake = fakeSpawn({ hang: true });
  const result = await createLocalEnvironment({ spawn: fake.spawn }).run({ action: 'docker', args: ['exec', 'c1', 'sleep', '99'], timeoutMs: 1 });
  assert.equal(fake.launches[0]!.killed, true);
  assert.equal(result.uncertain, true);
  assert.notEqual(result.code, 0);
});

test('the toast runs with the text in its environment; a failed toast is a non-zero code for the notifier', async () => {
  const fake = fakeSpawn({ exit: 3 });
  const env = createLocalEnvironment({ spawn: fake.spawn });
  await assert.rejects(windowsToast(env)({ id: 'x:r1', text: 'Pronto', ref: 'x' }), /toast_failed/);
  assert.equal(fake.launches[0]!.env?.OPTCHAT_TOAST_TEXT, 'Pronto');
  assert.ok(!fake.launches[0]!.args.join(' ').includes('Pronto'));
});

test('the docker runner resolves through the port with the same arguments and timeout the CLI used', async () => {
  const seen: unknown[] = [];
  const port = { run: async (request: unknown) => { seen.push(request); return { code: 0, stdout: '{}', stderr: '', uncertain: false }; }, open: () => { throw new Error('unused'); } };
  const docker = dockerVia(port);
  assert.deepEqual(await docker(['inspect', '--type', 'container', 'c1'], { timeoutMs: 15_000 }), { code: 0, stdout: '{}', stderr: '', uncertain: false });
  assert.deepEqual(seen, [{ action: 'docker', args: ['inspect', '--type', 'container', 'c1'], timeoutMs: 15_000 }]);
});

test('a stream is a live child: the viewer and relay use the same allow-listed argv through the adapter', () => {
  const fake = fakeSpawn({});
  const child = createLocalEnvironment({ spawn: fake.spawn }).open({ action: 'docker_stream', container: 'c1', program: 'socat-viewer' });
  assert.equal(fake.launches[0]!.file, 'docker');
  assert.deepEqual(fake.launches[0]!.args, ['exec', '-i', 'c1', 'socat', '-', 'TCP:127.0.0.1:6088']);
  assert.equal(typeof child.stdin.write, 'function');
  child.kill();
  assert.ok(localEnvironment && typeof localEnvironment.run === 'function', 'the shared adapter is exported');
});

// ---- The loopback daemon -----------------------------------------------------------------------

function tempDir() { return mkdtempSync(join(tmpdir(), 'assistant-env-')); }

test('the token file is created once, owner-only, and a malformed one is refused rather than replaced', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'private', 'daemon.token');
    const token = loadOrCreateToken(path);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(loadOrCreateToken(path), token, 'the same token is read on every start');
    writeFileSync(path, 'short\n');
    assert.throws(() => loadOrCreateToken(path), /daemon_token_invalid/);
    assert.equal(readFileSync(path, 'utf8'), 'short\n', 'the malformed file is left as it is');
    assert.throws(() => loadOrCreateToken('relative.token'), TypeError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function withDaemon(fn: (endpoint: string, token: string, fake: ReturnType<typeof fakeSpawn>) => Promise<void>, script: FakeScript = { stdout: 'pong', exit: 0 }) {
  const fake = fakeSpawn(script);
  const token = 'T'.repeat(43);
  const daemon = await startEnvironmentDaemon({ environment: createLocalEnvironment({ spawn: fake.spawn }), token });
  try { await fn(daemon.endpoint, token, fake); }
  finally { await daemon.close(); }
}

test('the daemon listens on loopback only and answers an allow-listed run with the same result as the adapter', () => withDaemon(async (endpoint, token, fake) => {
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  const client = daemonEnvironment({ endpoint, token });
  assert.deepEqual(await client.run({ action: 'docker', args: ['ps'] }), { code: 0, stdout: 'pong', stderr: '', uncertain: false });
  assert.deepEqual(fake.launches.map(l => [l.file, l.args]), [['docker', ['ps']]]);
}));

test('the daemon refuses requests without the exact bearer token before reading them', () => withDaemon(async (endpoint, token, fake) => {
  const post = (headers: Record<string, string>, body = '{"action":"docker","args":["ps"]}') => fetch(`${endpoint}/v1/run`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post({ authorization: `Basic ${token}` })).status, 401);
  assert.equal((await post({ authorization: `Bearer ${token}x` })).status, 401);
  assert.equal(fake.launches.length, 0, 'an unauthenticated request starts nothing');
  assert.equal((await post({ authorization: `Bearer ${token}` })).status, 200);
}));

test('the daemon routes only POST /v1/run and returns allow-list refusals as 400 with a code, starting nothing', () => withDaemon(async (endpoint, token, fake) => {
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${endpoint}/v1/run`, { headers: auth })).status, 404, 'GET is not a run');
  assert.equal((await fetch(`${endpoint}/v1/other`, { method: 'POST', headers: auth, body: '{}' })).status, 404);
  const refused = await fetch(`${endpoint}/v1/run`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'docker', args: ['system', 'prune'] }) });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'docker_subcommand_refused' });
  assert.equal((await fetch(`${endpoint}/v1/run`, { method: 'POST', headers: auth, body: '{not json' })).status, 400);
  assert.equal((await fetch(`${endpoint}/v1/run`, { method: 'POST', headers: auth, body: 'x'.repeat(70 * 1024) })).status, 413);
  assert.equal(fake.launches.length, 0);
}));

test('the client carries the one-shot actions and refuses streams, and it only talks to loopback', () => withDaemon(async (endpoint, token) => {
  const client = daemonEnvironment({ endpoint, token: 'wrong'.padEnd(43, 'x') });
  await assert.rejects(client.run({ action: 'docker', args: ['ps'] }), { name: 'EnvironmentRefused', message: 'unauthorized' });
  const ok = daemonEnvironment({ endpoint, token });
  assert.throws(() => ok.open({ action: 'docker_stream', container: 'c1', program: 'socat-viewer' }), /stream_not_remotable/);
  assert.throws(() => daemonEnvironment({ endpoint: 'http://example.test:8080', token }), /loopback/);
}));
