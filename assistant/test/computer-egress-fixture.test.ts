import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { startBrowserRelay } from '../src/computer/relay.ts';
import { withComputers } from './computer-support.ts';

test('real isolated browser refuses cross-origin/private redirects, mixed DNS, writes and oversized replies against controlled upstream', () => withComputers(async ({ computers, authority }) => {
  const hits: string[] = [];
  const lookups: string[] = [];
  const fixture = createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === '/redirect-other') res.writeHead(302, { location: 'https://ungranted.invalid/secret' }).end();
    else if (req.url === '/redirect-private') res.writeHead(302, { location: 'https://127.0.0.1/secret' }).end();
    else if (req.url === '/redirect-mixed') res.writeHead(302, { location: 'https://mixed.test/secret' }).end();
    else if (req.url === '/large') res.end(Buffer.alloc(2 * 1024 * 1024 + 1));
    else res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session=not-forwarded' }).end('<h1>Controlled proxy page</h1>');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const port = (fixture.address() as { port: number }).port;
  const c = await computers.create('p', 'controlled');
  const relay = await startBrowserRelay(computers, c.id, ['https://public.test', 'https://mixed.test'], Date.now() + 90_000, {
    resolve: async host => { lookups.push(host); return host === 'mixed.test' ? ['1.1.1.1', '10.0.0.1'] : ['1.1.1.1']; },
    transport: ((options: any, callback: any) => httpRequest({ hostname: '127.0.0.1', port, path: options.path, method: options.method, headers: options.headers, signal: options.signal }, callback)) as any,
  });
  const args = `--proxy-server=http://127.0.0.1:${relay.port},--proxy-bypass-list=<-loopback>,--disable-quic,--no-sandbox,--disable-dev-shm-usage,--disable-gpu`;
  const run = (argv: string[]) => computers.exec(c.id, ['agent-browser', '--session', 'fixture', '--args', args, ...argv], { timeoutMs: 45_000 });
  try {
    const opened = await run(['open', 'https://public.test/']);
    assert.equal(opened.code, 0, opened.stderr);
    assert.match((await run(['snapshot'])).stdout, /Controlled proxy page/);
    const result = await run(['eval', `(async()=>{
      const get=async path=>{try{const r=await fetch(path);return {status:r.status,body:await r.text()}}catch{return {status:'blocked'}}};
      return JSON.stringify({other:await get('/redirect-other'),internal:await get('/redirect-private'),mixed:await get('/redirect-mixed'),large:await get('/large'),cookie:document.cookie});
    })()`]);
    assert.equal(result.code, 0, result.stderr);
    const value = JSON.parse(JSON.parse(result.stdout));
    assert.equal(value.other.status, 'blocked');
    assert.equal(value.internal.status, 'blocked');
    assert.equal(value.mixed.status, 'blocked');
    assert.equal(value.large.status, 403);
    assert.equal(value.cookie, '');
    assert.ok(!hits.includes('/secret'), 'redirected private/mixed/ungranted requests must never reach the upstream');
    assert.ok(!lookups.includes('ungranted.invalid'), 'ungranted destinations must not even cause host DNS');
    assert.ok(lookups.includes('mixed.test'), 'mixed DNS refusal was exercised in the real broker');
    assert.ok(relay.failures() >= 2, 'mixed DNS and response bound failures are recorded');
    assert.equal((await run(['close'])).code, 0);
    await computers.takeover(c.id, authority);
    // A real broker process ends when takeover is observed; await close, not a polling loop.
    await relay.close();
    computers.handBack(c.id, authority);
  } finally {
    await relay.close();
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
}, { image: 'optchat-computer-browser-egress:1' }));
