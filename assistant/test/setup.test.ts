import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  checkSetup, capabilities, defaultComponents, storeProbe, vaultProbe, dockerProbe, modelProbe, endpointProbe, connectionProbe, inferenceProbe,
  type SetupComponent,
} from '../src/setup.ts';

const NOW = Date.parse('2026-10-28T20:00:00Z');
const component = (id: string, probe: SetupComponent['probe'], capabilitiesList: string[] = []): SetupComponent =>
  ({ id, label: id, fix: `configure ${id}`, capabilities: capabilitiesList, probe });

test('only an exercised, recent, evidenced probe is ready; presence, staleness, failure and timeouts are not', async () => {
  const items = await checkSetup([
    component('ok', async () => ({ kind: 'exercised', detail: 'leu', evidence: 'select 1', at: NOW - 1000 })),
    component('present', async () => ({ kind: 'present', detail: 'credencial salva' })),
    component('stale', async () => ({ kind: 'exercised', detail: 'leu', evidence: 'x', at: NOW - 48 * 3600_000 })),
    component('no-evidence', async () => ({ kind: 'exercised', detail: 'leu', evidence: '', at: NOW })),
    component('missing', async () => ({ kind: 'missing', detail: 'n\ão configurado' })),
    component('invalid', async () => ({ kind: 'invalid', detail: 'URL inv\álida' })),
    component('throws', async () => { throw new Error('boom secret=abc'); }),
    component('slow', () => new Promise(() => {})),
  ], { now: () => NOW, timeoutMs: 50 });
  const status = Object.fromEntries(items.map(item => [item.id, item.status]));
  assert.deepEqual(status, { ok: 'ready', present: 'not_verified', stale: 'not_verified', 'no-evidence': 'not_verified', missing: 'needs_setup', invalid: 'needs_setup', throws: 'needs_setup', slow: 'not_verified' });
  for (const item of items) assert.ok(item.fix.length > 0, 'every item names a concrete fix');
  assert.equal(items.find(item => item.id === 'throws')!.detail.includes('secret=abc'), false, 'probe errors are not echoed');
  assert.equal(items.find(item => item.id === 'ok')!.evidence, 'select 1');
});

test('store and vault probes exercise the real local mechanism; a missing database is not created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-setup-'));
  try {
    const path = join(dir, 'tasks.sqlite');
    const absent = await storeProbe(path)();
    assert.equal(absent.kind, 'missing');
    assert.throws(() => new DatabaseSync(path, { readOnly: true }), 'probe must not create the file');
    new DatabaseSync(path).close();
    assert.equal((await storeProbe(path)()).kind, 'exercised');
    const echo = { protect: async (b: Buffer) => Buffer.from(b), unprotect: async (b: Buffer) => Buffer.from(b) };
    assert.equal((await vaultProbe(echo)()).kind, 'exercised');
    const broken = { protect: async (b: Buffer) => Buffer.from(b), unprotect: async () => Buffer.from('other') };
    assert.equal((await vaultProbe(broken)()).kind, 'failed', 'a protector that does not round-trip is not ready');
    const unavailable = { protect: () => Promise.reject(new Error('no dpapi')), unprotect: () => Promise.reject(new Error('no')) };
    assert.equal((await vaultProbe(unavailable)()).kind, 'failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('docker backend without the pinned image is present, not ready; no engine needs setup', async () => {
  const runner = (info: number, image: number) => async (args: readonly string[]) =>
    args[0] === 'info' ? { code: info, stdout: JSON.stringify({ ServerVersion: '29', OperatingSystem: 'x', SecurityOptions: ['name=seccomp'] }), stderr: '' } : { code: image, stdout: '', stderr: '' };
  assert.equal((await dockerProbe('img', runner(0, 0))()).kind, 'exercised');
  assert.equal((await dockerProbe('img', runner(0, 1))()).kind, 'present');
  assert.equal((await dockerProbe('img', runner(1, 0))()).kind, 'missing');
});

test('the model check never calls a model; inference is a separate opt-in with a declared cost', async () => {
  assert.equal((await modelProbe(undefined)()).kind, 'missing');
  assert.equal((await modelProbe('not a model ref')()).kind, 'invalid');
  const configured = await modelProbe('anthropic-account-2/claude-opus-5-5')();
  assert.equal(configured.kind, 'present');
  assert.throws(() => inferenceProbe({ declaredCost: '', consent: true, run: async () => 'ok' }), /cost/);
  assert.throws(() => inferenceProbe({ declaredCost: 'US$0,001', consent: false as true, run: async () => 'ok' }), /consent/);
  let calls = 0;
  const probe = inferenceProbe({ declaredCost: 'US$0,001', consent: true, run: async () => { calls++; return 'pong'; } });
  assert.equal(calls, 0, 'constructing the opt-in does not run it');
  assert.equal((await probe()).kind, 'exercised'); assert.equal(calls, 1);
});

test('invalid URLs and failing endpoints are never ready', async () => {
  const server = createServer((req, res) => { res.statusCode = req.url === '/ok' ? 200 : 500; res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const bad of ['', 'nota url', 'ftp://127.0.0.1/x', 'http://user:pass@127.0.0.1/', 'javascript:alert(1)'])
      assert.equal((await endpointProbe(bad)()).kind, 'invalid', bad);
    assert.equal((await endpointProbe(`${base}/fail`)()).kind, 'failed');
    assert.equal((await endpointProbe('http://127.0.0.1:1/')()).kind, 'failed');
    assert.equal((await endpointProbe(`${base}/ok`)()).kind, 'exercised');
  } finally { server.close(); }
});

test('account identity: a connection is ready only with a verified expected identity and a recent successful read', async () => {
  const base = { configured: true, expectedAccount: 'eu@pessoal.test', observedAccount: 'eu@pessoal.test', identityVerified: true, revoked: false, lastReadAt: NOW - 60_000 };
  const kind = async (state: Partial<typeof base>) => (await connectionProbe(() => ({ ...base, ...state }), () => NOW)()).kind;
  assert.equal(await kind({}), 'exercised');
  assert.equal(await kind({ configured: false }), 'missing');
  assert.equal(await kind({ revoked: true }), 'failed');
  assert.equal(await kind({ identityVerified: false }), 'invalid');
  assert.equal(await kind({ observedAccount: 'outra@dentai.test' }), 'invalid', 'a different account is not silently accepted');
  assert.equal(await kind({ lastReadAt: undefined }), 'present');
});

test('the default checklist covers runtime, model, storage, keys, isolation, Google and notifications; unconfigured ones are never ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-defaults-'));
  try {
    const path = join(dir, 'tasks.sqlite'); new DatabaseSync(path).close();
    const echo = { protect: async (b: Buffer) => Buffer.from(b), unprotect: async (b: Buffer) => Buffer.from(b) };
    const noDocker = async () => ({ code: 1, stdout: '', stderr: '' });
    const comps = defaultComponents({ databasePath: path, protector: echo, docker: noDocker });
    assert.deepEqual(comps.map(c => c.id), ['runtime', 'model', 'storage', 'keys', 'isolation', 'google', 'notifications']);
    const status = Object.fromEntries((await checkSetup(comps)).map(item => [item.id, item.status]));
    assert.deepEqual(status, { runtime: 'ready', model: 'needs_setup', storage: 'ready', keys: 'ready', isolation: 'needs_setup', google: 'needs_setup', notifications: 'needs_setup' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('declining a source keeps local mode useful and labels exactly what is unavailable', async () => {
  const comps = [
    component('store', async () => ({ kind: 'exercised', detail: 'ok', evidence: 'select', at: NOW }), ['tasks', 'routines']),
    component('google', async () => ({ kind: 'missing', detail: 'n\ão conectado' }), ['email-briefing', 'calendar']),
  ];
  const items = await checkSetup(comps, { now: () => NOW });
  const caps = capabilities(items, comps, new Set(['google']));
  assert.deepEqual(caps.filter(cap => cap.available).map(cap => cap.capability).sort(), ['routines', 'tasks']);
  const email = caps.find(cap => cap.capability === 'email-briefing')!;
  assert.equal(email.available, false);
  assert.match(email.reason, /Agora n\ão/);
  const undecided = capabilities(items, comps, new Set());
  assert.match(undecided.find(cap => cap.capability === 'calendar')!.reason, /configure google/);
});
