import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayReadHeaders, relayConnectTarget } from '../computer/relay-policy.mjs';

const origin = 'https://public.test';
const request = () => ({ method: 'GET', url: '/page', rawHeaders: ['Host', 'public.test'], headers: { host: 'public.test', accept: 'text/html' } });
test('relay binds CONNECT to a granted context, never forwards opaque TLS early bytes', () => {
  const target = {};
  const contexts = new Map([['public.test:443', target]]);
  assert.equal(relayConnectTarget('PUBLIC.TEST:443', Buffer.alloc(0), contexts), target);
  for (const authority of ['127.0.0.1:443', 'other.test:443', 'public.test:8443', undefined]) assert.equal(relayConnectTarget(authority, Buffer.alloc(0), contexts), undefined);
  assert.equal(relayConnectTarget('public.test:443', Buffer.from('smuggled'), contexts), undefined);
});
test('relay refuses authority confusion, writes, bodies, credentials, upgrades and concurrency/burst excess', () => {
  assert.deepEqual(relayReadHeaders(origin, request(), 0, 0), { accept: 'text/html' });
  assert.ok(relayReadHeaders(origin, { ...request(), method: 'HEAD', headers: { host: 'public.test', 'content-length': '0' } }, 15, 511));
  for (const r of [
    { ...request(), rawHeaders: [] }, { ...request(), rawHeaders: ['Host', 'public.test', 'Host', 'public.test'] },
    { ...request(), headers: { host: 'other.test' } }, { ...request(), method: 'POST' }, { ...request(), method: 'CONNECT' },
    { ...request(), url: 'https://other.test/' },
    ...['transfer-encoding', 'authorization', 'proxy-authorization', 'cookie', 'upgrade'].map(name => ({ ...request(), headers: { host: 'public.test', [name]: '' } })),
    { ...request(), headers: { host: 'public.test', 'content-length': '1' } },
  ]) assert.equal(relayReadHeaders(origin, r, 0, 0), null);
  assert.equal(relayReadHeaders(origin, request(), 16, 0), null);
  assert.equal(relayReadHeaders(origin, request(), 0, 512), null);
  assert.deepEqual(relayReadHeaders(origin, { ...request(), headers: { host: 'public.test', 'x-private': 'never-forwarded' } }, 0, 0), {});
});
