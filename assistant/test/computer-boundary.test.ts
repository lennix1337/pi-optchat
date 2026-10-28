import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { navigate, runShell, shellRequest } from '../src/computer/effects.ts';
import { checkNavigation, isInternalHost } from '../src/computer/network.ts';
import { base, inspectContainer, withComputers } from './computer-support.ts';

// Every writable or mountable place; /proc, /sys and /dev are skipped because grep would read device files forever.
const DIRS = '/work /tmp /home /root /mnt /media /run /srv /opt /etc /var';

test('a computer has no network, mounts, socket, capabilities or root, and a read-only root filesystem', () => withComputers(async ({ computers, gateway }) => {
  const a = await computers.create('p', 'agent-a');
  const info = await inspectContainer(a.container);
  assert.ok(info);
  assert.equal(info.HostConfig.NetworkMode, 'none');
  assert.equal(info.HostConfig.Privileged, false);
  assert.equal(info.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(info.HostConfig.CapDrop, ['ALL']);
  assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(info.HostConfig.Binds, null, 'no bind mounts');
  assert.deepEqual(info.Mounts, [], 'no volumes or host paths');
  assert.equal(info.Config.User, '1000:1000');
  const run = async (script: string) => runShell(gateway, computers, shellRequest(base(), a, ['sh', '-c', script]));
  assert.equal((await run('id -u')).stdout.trim(), '1000');
  assert.match((await run('grep CapEff /proc/self/status')).stdout, /CapEff:\s+0{16}/);
  assert.equal((await run('ls /sys/class/net')).stdout.trim(), 'lo', 'only loopback exists');
  assert.notEqual((await run('test -e /var/run/docker.sock')).code, 0, 'no docker socket');
  assert.notEqual((await run('wget -q -T 2 -O- http://169.254.169.254/latest/meta-data/')).code, 0, 'metadata unreachable');
  assert.notEqual((await run('touch /etc/probe')).code, 0, 'root filesystem is read-only');
  assert.equal((await run('echo ok > /work/probe && cat /work/probe')).stdout.trim(), 'ok', 'own workspace is writable');
}));

test('agent B cannot read agent A\'s files or token, and neither sees a host file', () => withComputers(async ({ dir, computers, gateway }) => {
  const HOST = 'host-canary-7f3a91';
  writeFileSync(join(dir, 'host-secret.txt'), HOST);
  const a = await computers.create('p', 'agent-a');
  const b = await computers.create('p', 'agent-b');
  assert.notEqual(a.container, b.container);
  const TOKEN = 'token-canary-5b2e88';
  const wrote = await runShell(gateway, computers, shellRequest(base(), a, ['sh', '-c', `printf ${TOKEN} > /work/token && cat /work/token`]));
  assert.equal(wrote.stdout, TOKEN);
  const fromB = await runShell(gateway, computers, shellRequest(base(), b, ['sh', '-c', `cat /work/token; ls -A /work; grep -rs ${TOKEN} ${DIRS}; grep -rs ${HOST} ${DIRS}; echo end`]));
  assert.equal(fromB.stdout.trim(), 'end', 'B sees no token, no files and no host canary');
  const fromA = await runShell(gateway, computers, shellRequest(base(), a, ['sh', '-c', `grep -rs ${HOST} ${DIRS}; echo end`]));
  assert.equal(fromA.stdout.trim(), 'end', 'the host file is invisible to A too');
  await assert.rejects(runShell(gateway, computers, { ...shellRequest(base(), a, ['cat', '/work/token']), destination: b.container }), /computer_destination_mismatch/, 'a grant for A cannot target B');
}));

test('shell commands need the gateway: a reviewed effect runs nothing until approved', () => withComputers(async ({ computers, gateway }) => {
  const a = await computers.create('p', 'agent-a');
  const request = shellRequest(base(), a, ['sh', '-c', 'echo ran > /work/marker']);
  await assert.rejects(runShell(gateway, computers, request), /approval_required/);
  const check = await computers.exec(a.id, ['sh', '-c', 'test -e /work/marker && echo present || echo absent']);
  assert.equal(check.stdout.trim(), 'absent');
}, {}, () => 'review'));

test('internal, metadata, rebinding and ungranted navigation is refused; granted public origins fail closed without a browser', () => withComputers(async ({ computers }) => {
  const a = await computers.create('p', 'agent-a');
  const granted = ['https://example.com'];
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:8080', 'http://10.0.0.1', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://metadata.google.internal/', 'http://host.docker.internal/', 'http://100.100.100.100/', 'http://router/', 'http://nas.local/']) {
    await assert.rejects(navigate(computers, a.id, url, [...granted, new URL(url).origin]), /navigation_internal_target/, url);
  }
  await assert.rejects(navigate(computers, a.id, 'file:///etc/passwd', granted), /navigation_scheme_not_allowed/);
  await assert.rejects(navigate(computers, a.id, 'https://user:pw@example.com/', granted), /navigation_credentials_in_url/);
  await assert.rejects(navigate(computers, a.id, 'https://other.example.org/', granted), /navigation_origin_not_granted/);
  await assert.rejects(navigate(computers, a.id, 'https://example.com/', granted, async () => ['10.0.0.5']), /navigation_internal_target/, 'DNS rebinding to a private address');
  await assert.rejects(navigate(computers, a.id, 'https://example.com/', granted, async () => ['93.184.215.14']), /computer_browser_unprovisioned/);
}));

test('address classification covers every internal range the browser must never reach', () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:a00:1', 'localhost', 'x.localhost', 'svc.internal', 'intranet'])
    assert.equal(isInternalHost(host), true, host);
  for (const host of ['93.184.215.14', '172.32.0.1', '100.128.0.1', '2606:4700::1111', 'example.com'])
    assert.equal(isInternalHost(host), false, host);
  assert.deepEqual(checkNavigation('https://example.com/a?b', ['https://example.com']), { ok: true, origin: 'https://example.com' });
});
