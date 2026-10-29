import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { readPublicPage, MAX_RESPONSE_BYTES } from '../src/computer/egress.ts';

test('real loopback HTTP response fixture proves bounded body, no redirect following, no cookies and revocation', async () => {
  const hits: string[] = [];
  let held = false;
  const server = createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === '/redirect') res.writeHead(302, { location: 'https://other.example/', 'set-cookie': 'session=private' }).end('redirect');
    else if (req.url === '/large') res.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1));
    else if (req.url === '/encoded') res.writeHead(200, { 'content-encoding': 'gzip' }).end('compressed');
    else if (req.url === '/revoke') { held = true; res.end('private result'); }
    else res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'session=private', 'x-private-fixture': 'not-forwarded' }).end('fixture visible');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const policy = { origins: ['https://example.com'], admit() { if (held) throw new Error('revoked'); }, resolve: async () => ['1.1.1.1'] };
  // Only the test replaces transport with loopback. The production broker always uses verified HTTPS.
  const transport = ((options: any, callback: any) => {
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.hostname, 'example.com');
    return httpRequest({ hostname: '127.0.0.1', port, method: options.method, path: options.path, signal: options.signal, headers: options.headers }, callback);
  }) as any;
  const get = (path: string, signal = AbortSignal.timeout(3000)) => readPublicPage({ id: 1, url: `https://example.com${path}`, method: 'GET', headers: {} }, policy, signal, transport);
  try {
    const ok = await get('/ok');
    assert.equal(Buffer.from(ok.body, 'base64').toString(), 'fixture visible');
    assert.equal(ok.headers['set-cookie'], undefined);
    assert.equal(ok.headers['x-private-fixture'], undefined);
    const redirect = await get('/redirect');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, 'https://other.example/');
    assert.deepEqual(hits, ['/ok', '/redirect'], 'only the browser may request the next URL through admission again');
    await assert.rejects(get('/large'), /egress_response_too_large/);
    await assert.rejects(get('/encoded'), /egress_unsupported_encoding/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(get('/aborted', controller.signal), /abort/i);
    await assert.rejects(get('/revoke'), /revoked/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
