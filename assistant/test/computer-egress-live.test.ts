import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserReadRequest, openBrowserRead } from '../src/computer/browser-egress.ts';
import { startBrowserRelay } from '../src/computer/relay.ts';
import { base, withComputers } from './computer-support.ts';

const image = 'optchat-computer-browser-egress:1';
const origins = ['https://httpbingo.org'];

test('real granted HTTPS page goes gateway → pinned TLS → network-none browser → visible snapshot', () => withComputers(async ({ computers, gateway, authority }) => {
  const c = await computers.create('p', 'public');
  const request = browserReadRequest(base(), c, { url: 'https://httpbingo.org/html', origins });
  const review = gateway.prepare(request);
  assert.equal(review.decision, 'review');
  if (review.decision !== 'review') throw new Error('expected_review');
  gateway.decide(review.reviewId, 'approve', authority);
  await assert.rejects(openBrowserRead(gateway, computers, { ...request, payload: Buffer.from(JSON.stringify({ url: 'https://httpbingo.org/get', origins })) }), /approval_required/);
  assert.equal(gateway.status(request.operationId), 'absent');
  const result = await openBrowserRead(gateway, computers, request);
  assert.match(result.snapshot, /Moby.Dick|Herman Melville/i);
  assert.match(result.caFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(gateway.status(request.operationId), 'response_recorded');
  await assert.rejects(openBrowserRead(gateway, computers, request), /operation_already_dispatched/);
}, { image }, () => 'review'));

test('real browser checks redirects, subresource fetch, internal/downgrade destinations and POST independently', () => withComputers(async ({ computers }) => {
  const c = await computers.create('p', 'transport');
  const relay = await startBrowserRelay(computers, c.id, origins, Date.now() + 90_000);
  const args = `--proxy-server=http://127.0.0.1:${relay.port},--proxy-bypass-list=<-loopback>,--disable-quic,--no-sandbox,--disable-dev-shm-usage,--disable-gpu`;
  const run = (argv: string[]) => computers.exec(c.id, ['agent-browser', '--session', 'transport', '--args', args, ...argv], { timeoutMs: 45_000 });
  try {
    const opened = await run(['open', 'https://httpbingo.org/html']);
    assert.equal(opened.code, 0, opened.stderr);
    const evaluated = await run(['eval', `(async()=>{
      const read=async(url,options)=>{try{return (await fetch(url,options)).status}catch{return 'blocked'}};
      return JSON.stringify({
        allowed:await read('/get'),
        redirectAllowed:await read('/redirect-to?url=%2Fget'),
        other:await read('https://ungranted.invalid/'),
        internal:await read('https://127.0.0.1/'),
        downgrade:await read('http://httpbingo.org/get'),
        post:await read('/post',{method:'POST'})
      });})()`]);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    const text = JSON.parse(JSON.parse(evaluated.stdout));
    assert.deepEqual(text, { allowed: 200, redirectAllowed: 200, other: 'blocked', internal: 'blocked', downgrade: 'blocked', post: 403 });
  } finally {
    const close = await run(['close']);
    await relay.close();
    assert.equal(close.code, 0, close.stderr);
  }
}, { image }));
