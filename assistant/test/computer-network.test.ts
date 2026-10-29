import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { checkNavigation, isInternalHost } from '../src/computer/network.ts';

test('reserved IPv4 and equivalent IPv6 special addresses are refused', () => {
  for (const address of [
    '192.0.2.1', '198.51.100.1', '203.0.113.1', '192.88.99.1',
    '::1', '0:0:0:0:0:0:0:1', '::', '0:0:0:0:0:0:0:0', 'fe80::1%eth0',
    '::ffff:8.8.8.8', '0:0:0:0:0:ffff:808:808',
    '64:ff9b::808:808', '64:ff9b:1::1', '2001:db8::1', '2001:0db8:0:0:0:0:0:1',
    '2002:0808:0808::1', '2001:0::1', '3fff::1', '100::1',
  ]) assert.equal(isInternalHost(address), true, address);
});

test('public addresses and explicitly granted origins are admitted', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2606:4700:4700:0:0:0:0:1111']) {
    assert.equal(isInternalHost(address), false, address);
  }
  assert.deepEqual(checkNavigation('https://example.com/path', ['https://example.com'], ['8.8.8.8', '2606:4700:4700::1111']), { ok: true, origin: 'https://example.com' });
});

test('resolved answers and URL controls fail closed', () => {
  for (const addresses of [['8.8.8.8', '192.0.2.1'], ['8.8.8.8', 'not-an-ip'], ['8.8.8.8', '0:0:0:0:0:0:0:1']]) {
    assert.deepEqual(checkNavigation('https://example.com/', ['https://example.com'], addresses), { ok: false, reason: 'internal_target' });
  }
  for (const [url, origins, reason] of [
    ['not a url', [], 'invalid_url'], ['file:///etc/passwd', [], 'scheme_not_allowed'],
    ['https://user:pass@example.com/', ['https://example.com'], 'credentials_in_url'],
    ['https://127.0.0.1/', ['https://127.0.0.1'], 'internal_target'],
    ['https://example.com/', ['https://example.com:444'], 'origin_not_granted'],
  ] as const) assert.deepEqual(checkNavigation(url, origins), { ok: false, reason });
});
