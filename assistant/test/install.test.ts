import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { privateDir } from './vault-support.ts';
import { TOKEN, freePort, killRecordedService, runScript, runScriptAsync, serviceHome } from './ops-support.ts';

async function portOpen(port: number): Promise<boolean> {
  const socket = createConnection(port, '127.0.0.1');
  try { await once(socket, 'connect'); return true; } catch { return false; } finally { socket.destroy(); }
}

test('start, health and stop are idempotent, diagnostic and never print the token', { timeout: 120_000 }, () => privateDir('ops-install-', async root => {
  const port = await freePort();
  const svc = serviceHome(root, port);
  try {
    const before = runScript('health', ['--config', svc.config]);
    assert.equal(before.status, 1); assert.equal(before.json.state, 'stopped');

    const started = runScript('start', ['--config', svc.config]);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    assert.equal(started.json.result, 'started');
    const pid = started.json.pid as number;
    assert.ok(Number.isSafeInteger(pid));
    const record = JSON.parse(readFileSync(join(svc.home, 'assistant-service.json'), 'utf8'));
    assert.equal(record.pid, pid); assert.equal(typeof record.processStartTime, 'string'); assert.ok(record.processStartTime.length > 0);

    const again = runScript('start', ['--config', svc.config]);
    assert.equal(again.status, 0); assert.equal(again.json.result, 'already_running'); assert.equal(again.json.pid, pid);

    const health = runScript('health', ['--config', svc.config]);
    assert.equal(health.status, 0, health.stdout);
    assert.equal(health.json.state, 'healthy'); assert.equal(health.json.pid, pid); assert.equal(health.json.api, 'ok');
    assert.ok((health.json.workingSetBytes as number) > 0, 'reports memory consumption');
    assert.ok((health.json.dataBytes as number) > 0, 'reports database size');

    const stopped = runScript('stop', ['--config', svc.config]);
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr); assert.equal(stopped.json.result, 'stopped'); assert.equal(stopped.json.mode, 'graceful');
    assert.equal(await portOpen(port), false);
    assert.equal(existsSync(join(svc.home, 'assistant-service.json')), false);
    const twice = runScript('stop', ['--config', svc.config]);
    assert.equal(twice.status, 0); assert.equal(twice.json.result, 'not_running');

    for (const output of [before, started, again, health, stopped, twice]) assert.doesNotMatch(output.stdout + output.stderr, new RegExp(TOKEN));
    assert.doesNotMatch(readFileSync(join(svc.home, 'assistant-service.log'), 'utf8'), new RegExp(TOKEN));
  } finally { killRecordedService(svc.home); }
}));

test('start refuses a port it does not own and leaves the listener alone', { timeout: 60_000 }, () => privateDir('ops-port-', async root => {
  const foreign = createServer(socket => socket.destroy());
  foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
  const port = (foreign.address() as { port: number }).port;
  const svc = serviceHome(root, port);
  try {
    const started = runScript('start', ['--config', svc.config]);
    assert.equal(started.status, 1); assert.equal(started.json.code, 'port_in_use');
    assert.equal(existsSync(join(svc.home, 'assistant-service.json')), false);
    const health = runScript('health', ['--config', svc.config]);
    assert.equal(health.json.state, 'foreign_listener');
    const stopped = runScript('stop', ['--config', svc.config]);
    assert.equal(stopped.json.result, 'not_running');
    assert.equal(foreign.listening, true);
  } finally { killRecordedService(svc.home); foreign.close(); }
}));

test('concurrent starts launch exactly one service', { timeout: 120_000 }, () => privateDir('ops-race-', async root => {
  const svc = serviceHome(root, await freePort());
  try {
    const results = await Promise.all([runScriptAsync('start', ['--config', svc.config]), runScriptAsync('start', ['--config', svc.config])]);
    const outcomes = results.map(r => r.json.result === 'error' ? r.json.code : r.json.result).sort();
    assert.ok(outcomes.includes('started'), JSON.stringify(results));
    assert.equal(outcomes.filter(o => o === 'started').length, 1, JSON.stringify(outcomes));
    assert.ok(outcomes.every(o => ['started', 'already_running', 'service_busy'].includes(o as string)), JSON.stringify(outcomes));
    assert.equal(runScript('stop', ['--config', svc.config]).json.result, 'stopped');
  } finally { killRecordedService(svc.home); }
}));

test('Windows autostart is explicit opt-in: dry run by default, reversible, never touches files it did not write', { timeout: 60_000 }, () => privateDir('ops-autostart-', async root => {
  const svc = serviceHome(root, await freePort());
  // A disposable APPDATA, so even the default Startup folder resolves inside this test directory.
  const appData = join(root, 'appdata');
  const startup = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  mkdirSync(startup, { recursive: true });
  const env = { ...process.env, APPDATA: appData };
  const run = (...args: string[]) => runScript('autostart', args, { env });

  if (process.platform !== 'win32') {
    const refused = run('install', '--config', svc.config, '--yes');
    assert.equal(refused.status, 1); assert.equal(refused.json.code, 'autostart_unsupported');
    return;
  }
  const plan = run('install', '--config', svc.config);
  assert.equal(plan.status, 0); assert.equal(plan.json.result, 'dry_run');
  assert.deepEqual(readdirSync(startup), [], 'a dry run writes nothing');
  for (const words of [/writes: /, /consumption: /i, /retention: /i, /stop now: .*stop\.mjs/, /remove autostart: .*uninstall/, /No scheduled task, service or registry entry/]) assert.match(plan.stdout, words);

  const installed = run('install', '--config', svc.config, '--yes');
  assert.equal(installed.status, 0, installed.stdout + installed.stderr); assert.equal(installed.json.result, 'installed');
  const [launcher] = readdirSync(startup);
  assert.match(launcher, /^optchat-assistant-[0-9a-f]{12}\.cmd$/);
  const content = readFileSync(join(startup, launcher), 'utf8');
  assert.match(content, /start\.mjs" --config "/); assert.doesNotMatch(content, new RegExp(TOKEN));
  assert.equal(run('install', '--config', svc.config, '--yes').json.result, 'already_installed');

  assert.equal(run('uninstall', '--config', svc.config).json.result, 'dry_run');
  assert.ok(existsSync(join(startup, launcher)));
  assert.equal(run('uninstall', '--config', svc.config, '--yes').json.result, 'uninstalled');
  assert.deepEqual(readdirSync(startup), []);
  assert.equal(run('uninstall', '--config', svc.config, '--yes').json.result, 'not_installed');

  writeFileSync(join(startup, launcher), 'someone else\r\n');
  assert.equal(run('install', '--config', svc.config, '--yes').json.code, 'autostart_conflict');
  assert.equal(run('uninstall', '--config', svc.config, '--yes').json.code, 'autostart_conflict');
  assert.equal(readFileSync(join(startup, launcher), 'utf8'), 'someone else\r\n');
}));
