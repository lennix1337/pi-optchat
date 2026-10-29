import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOrigins, prepareRead, validateRead } from '../src/computer/egress.ts';

const origins = ['https://example.com'];
const read = () => ({ id: 1, url: 'https://example.com/page?q=1', method: 'GET', headers: { accept: 'text/html' } });

test('grants are bounded exact public HTTPS origins, not paths or arbitrary ports', () => {
  assert.deepEqual(normalizeOrigins([...origins, ...origins]), origins);
  for (const bad of [[], ['http://example.com'], ['https://localhost'], ['https://10.0.0.1'], ['https://example.com/'], ['https://1.1.1.1'], ['https://example.com:8443'], ['https://u:p@example.com'], Array(17).fill(origins[0])]) {
    assert.throws(() => normalizeOrigins(bad), /egress_invalid_origins/);
  }
});

test('untrusted relay cannot escalate origins, protocols, credentials, methods or headers', () => {
  assert.equal(validateRead(read(), origins).url, read().url);
  const values = [null, {}, { ...read(), id: -1 }, { ...read(), url: 'https://other.example/' },
    { ...read(), url: 'http://example.com/' }, { ...read(), url: 'https://example.com:8443/' },
    { ...read(), url: 'https://u:p@example.com/' }, { ...read(), url: 'https://example.com/#secret' },
    { ...read(), url: 'https://127.1/' }, { ...read(), method: 'POST' }, { ...read(), method: 'CONNECT' },
    { ...read(), headers: { authorization: 'secret' } }, { ...read(), headers: { cookie: 'secret' } },
    { ...read(), headers: { host: '127.0.0.1' } }, { ...read(), headers: { accept: 'a\r\nHost: internal' } },
    { ...read(), headers: { upgrade: 'websocket' } }];
  for (const value of values) assert.throws(() => validateRead(value, origins), /egress_/);
});

test('every request resolves again, rejects any private/mixed/non-IP result and rechecks admission', async () => {
  for (const addresses of [[], ['127.0.0.1'], ['1.1.1.1', '10.0.0.1'], ['::ffff:127.0.0.1'], ['garbage']]) {
    await assert.rejects(prepareRead(read(), { origins, admit() {}, resolve: async () => addresses }), /egress_(internal_target|unresolved)/);
  }
  let held = false;
  await assert.rejects(prepareRead(read(), { origins, admit() { if (held) throw new Error('revoked'); }, resolve: async () => { held = true; return ['1.1.1.1']; } }), /revoked/);
  let calls = 0;
  const policy = { origins, admit() {}, resolve: async () => ++calls === 1 ? ['1.1.1.1'] : ['192.168.1.1'] };
  await prepareRead(read(), policy);
  await assert.rejects(prepareRead(read(), policy), /internal_target/);
  assert.equal(calls, 2);
});

test('TLS connection is pinned to checked address, keeps hostname verification and never pools', async () => {
  const { options } = await prepareRead(read(), { origins, admit() {}, resolve: async () => ['1.1.1.1'] });
  assert.equal(options.hostname, 'example.com');
  assert.equal(options.servername, 'example.com');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.family, 4, 'explicit family keeps the pinned single-answer lookup out of Node multi-address selection');
  assert.equal(options.port, 443);
  assert.equal(options.path, '/page?q=1');
  assert.equal((options.headers as Record<string, string>)['accept-encoding'], 'identity');
  const result = await new Promise(resolve => (options.lookup as Function)('example.com', {}, (error: unknown, address: string, family: number) => resolve([error, address, family])));
  assert.deepEqual(result, [null, '1.1.1.1', 4]);
});
