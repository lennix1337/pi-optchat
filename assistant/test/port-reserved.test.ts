import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenFailureMessage } from '../src/main.ts';
import { listenFailure } from '../src/ops/service.ts';
import { privateDir } from './vault-support.ts';
import { killRecordedService, runScript, serviceHome } from './ops-support.ts';

const assistant = fileURLToPath(new URL('../', import.meta.url));
const error = (code: string) => Object.assign(new Error(`listen ${code}`), { code });

// 11/11: after a reboot WinNAT reserved 49692-49791, which held the endpoint port; the log said only "Listen failed."
test('a failed listen logs its error code, and on Windows names the reserved range and a port below 49152', () => {
  const reserved = listenFailureMessage(error('EACCES'), 49761, 'win32');
  assert.match(reserved, /^Listen failed: EACCES on 127\.0\.0\.1:49761\./);
  assert.match(reserved, /reserves this port/);
  assert.match(reserved, /excludedportrange/);
  assert.match(reserved, /below 49152/);
  assert.match(listenFailureMessage(error('EADDRINUSE'), 47761, 'win32'), /^Listen failed: EADDRINUSE on 127\.0\.0\.1:47761 \(address in use\)\..*below 49152/);
  assert.match(listenFailureMessage(error('EADDRINUSE'), 47761, 'linux'), /^Listen failed: EADDRINUSE on 127\.0\.0\.1:47761 \(address in use\)\./);
  assert.doesNotMatch(listenFailureMessage(error('EACCES'), 80, 'linux'), /Windows|49152/);
  assert.equal(listenFailureMessage(error('EMFILE'), 47761, 'win32'), 'Listen failed: EMFILE on 127.0.0.1:47761.');
  assert.equal(listenFailureMessage(new Error('no code'), 47761, 'win32'), 'Listen failed: UNKNOWN on 127.0.0.1:47761.');
});

test('the start script reads the listen verdict only from what this start appended to the log', () => privateDir('port-log-', async root => {
  const log = join(root, 'service.log');
  assert.equal(listenFailure(log, 0), undefined, 'no log yet');
  writeFileSync(log, 'Listen failed: EACCES on 127.0.0.1:49761.\n');
  const earlier = readFileSync(log).length;
  assert.equal(listenFailure(log, 0), 'port_reserved');
  assert.equal(listenFailure(log, earlier), undefined, 'an old failure is not this start\'s');
  writeFileSync(log, 'Listen failed: EACCES on 127.0.0.1:49761.\nListen failed: EADDRINUSE on 127.0.0.1:49761 (address in use).\n');
  assert.equal(listenFailure(log, earlier), 'port_in_use');
  assert.equal(listenFailure(log, 0), 'port_reserved');
}));

/** A disposable copy of this package whose server fails to listen with EACCES, the way a Windows excluded port range does. */
function reservedPortCopy(root: string): string {
  const dir = join(root, 'copy');
  for (const part of ['src', 'scripts', 'package.json']) cpSync(join(assistant, part), join(dir, part), { recursive: true });
  const path = join(dir, 'src/main.ts'), source = readFileSync(path, 'utf8');
  const listen = "server.listen(port, '127.0.0.1', () => {";
  assert.equal(source.split(listen).length, 2, 'unique anchor for the listen call');
  writeFileSync(path, source.replace(listen, "server.emit('error', Object.assign(new Error('listen EACCES: permission denied'), { code: 'EACCES' })); setInterval(() => {}, 1000); if (false) server.listen(port, '127.0.0.1', () => {"));
  return join(dir, 'scripts');
}

test('start answers port_reserved with the port when the listen fails with EACCES, instead of start_unhealthy', { timeout: 60_000 }, () => privateDir('port-reserved-', async root => {
  const svc = serviceHome(root, 47761 + 1000); // never listened on: the simulated server fails before it binds
  const dir = reservedPortCopy(root);
  try {
    const started = runScript('start', ['--config', svc.config], { dir });
    assert.equal(started.status, 1, started.stdout + started.stderr);
    assert.deepEqual(started.json, { result: 'error', code: 'port_reserved', port: 48761 });
    assert.match(started.stderr, /Listen failed: EACCES on 127\.0\.0\.1:48761/);
    assert.equal(runScript('health', ['--config', svc.config], { dir }).json.state, 'stopped', 'a failed start leaves nothing running');
  } finally { killRecordedService(svc.home); }
}));

test('every endpoint port the documentation shows is below the Windows dynamic range', () => {
  const ports = [...readFileSync(join(assistant, 'README.md'), 'utf8').matchAll(/http:\/\/127\.0\.0\.1:(\d+)/g)].map(m => Number(m[1]));
  assert.ok(ports.length >= 2, 'the README shows the server and client endpoints');
  for (const port of ports) assert.ok(port < 49152, `README example port ${port} is inside 49152-65535`);
});
