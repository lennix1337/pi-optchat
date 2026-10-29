import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startBrowserRelay } from '../src/computer/relay.ts';
import { browserReadRequest, openBrowserRead } from '../src/computer/browser-egress.ts';
import { base, withComputers, inspectContainer } from './computer-support.ts';

const image = 'optchat-computer-browser-egress:1';
const origins = ['https://httpbingo.org'];

test('Docker relay retains network-none, no mounts, denies direct TCP/DNS and removes its private CA', () => withComputers(async ({ computers, gateway, authority }) => {
  const c = await computers.create('p', 'broker');
  const request = browserReadRequest(base(), c, { url: 'https://httpbingo.org/html', origins });
  await assert.rejects(openBrowserRead(gateway, computers, request), /approval_required/);
  assert.equal(gateway.status(request.operationId), 'absent');
  await assert.rejects(openBrowserRead(gateway, computers, { ...request, profileId: 'other' }), /computer_profile_mismatch/);
  const relay = await startBrowserRelay(computers, c.id, origins, Date.now() + 60_000);
  try {
    const info = await inspectContainer(c.container);
    assert.equal(info?.HostConfig.NetworkMode, 'none');
    assert.deepEqual(info?.Mounts, []);
    assert.equal(info?.HostConfig.ReadonlyRootfs, true);
    const isolation = await computers.exec(c.id, ['node', '--input-type=module', '-e', `
      import net from 'node:net'; import {Resolver} from 'node:dns/promises';
      const tcp=await new Promise(r=>{const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(1500);s.on('connect',()=>{s.destroy();r('escaped')});s.on('error',()=>r('blocked'));s.on('timeout',()=>{s.destroy();r('blocked')})});
      const dns=new Resolver({timeout:500,tries:1});dns.setServers(['1.1.1.1']);let resolved='blocked';try{await dns.resolve4('httpbingo.org');resolved='escaped'}catch{}
      console.log(JSON.stringify({tcp,dns:resolved}));`]);
    assert.equal(isolation.code, 0, isolation.stderr);
    assert.deepEqual(JSON.parse(isolation.stdout), { tcp: 'blocked', dns: 'blocked' });
    const raw = await computers.exec(c.id, ['node', '--input-type=module', '-e', `
      import net from 'node:net';import tls from 'node:tls';import {readFileSync} from 'node:fs';
      const port=${relay.port};
      async function ask(authority,request){const s=net.connect({host:'127.0.0.1',port});s.setTimeout(3000,()=>s.destroy());await new Promise(r=>s.once('connect',r));s.write('CONNECT '+authority+' HTTP/1.1\\r\\nHost: '+authority+'\\r\\n\\r\\n');const first=await new Promise(r=>s.once('data',r));if(!String(first).includes('200')){s.destroy();return String(first)}const t=tls.connect({socket:s,servername:'httpbingo.org',ca:readFileSync('/work/egress-ca/ca.crt')});await new Promise((r,j)=>{t.once('secureConnect',r);t.once('error',j)});t.write(request);let text='';for await(const chunk of t)text+=chunk;return text}
      const badConnect=await ask('127.0.0.1:443','');
      const badHost=await ask('httpbingo.org:443','GET /get HTTP/1.1\\r\\nHost: other.example\\r\\nConnection: close\\r\\n\\r\\n');
      const post=await ask('httpbingo.org:443','POST /post HTTP/1.1\\r\\nHost: httpbingo.org\\r\\nContent-Length: 0\\r\\n\\r\\n');
      console.log(JSON.stringify([badConnect,badHost,post].map(v=>v.includes('403'))));`]);
    assert.equal(raw.code, 0, raw.stderr);
    assert.deepEqual(JSON.parse(raw.stdout), [true, true, true]);
    assert.equal(relay.failures(), 0, 'all probes are refused inside the relay before host DNS/HTTPS');
    await computers.takeover(c.id, authority);
    await relay.finished;
    assert.throws(() => relay.assertActive(), /egress_closed/);
    await assert.rejects(computers.exec(c.id, ['true']), /human_control/);
    computers.handBack(c.id, authority);
  } finally { await relay.close(); }
  const cleaned = await computers.exec(c.id, ['node', '-e', "const fs=require('fs');console.log(fs.existsSync('/work/egress-ca'))"]);
  assert.equal(cleaned.stdout.trim(), 'false');
  const trust = await computers.exec(c.id, ['certutil', '-L', '-d', 'sql:/work/.pki/nssdb']);
  assert.equal(trust.code, 0, trust.stderr);
  assert.doesNotMatch(trust.stdout, /OptChat disposable/);
}, { image }, () => 'review'));
