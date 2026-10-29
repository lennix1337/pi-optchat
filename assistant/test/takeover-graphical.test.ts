import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { connect } from 'node:net';
import { ComputerManager } from '../src/computer/manager.ts';
import { beginGraphicalTakeover } from '../src/computer/graphical-takeover.ts';

test('isolated graphical fixture serves owner and destroys the computer on handback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graphical-takeover-'));
  const authority = {};
  const manager = new ComputerManager({ databasePath: join(dir, 'state.sqlite'), owner: `demo-${Date.now()}`, image: 'optchat-computer-takeover:local', operatorAuthority: authority });
  let session: Awaited<ReturnType<typeof beginGraphicalTakeover>> | undefined;
  try {
    const computer = await manager.create('fixture', 'agent');
    const revocation = new AbortController();
    session = await beginGraphicalTakeover({ computers: manager, id: computer.id, authority, revocation: revocation.signal, authorizeOwner: request => request.headers['x-fixture-owner'] === 'yes' });
    const url = `http://127.0.0.1:${session.port}/`;
    assert.equal((await fetch(url)).status, 403);
    let result: Response | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      result = await fetch(url, { headers: { 'x-fixture-owner': 'yes' } });
      if (result.status === 200) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(result?.status, 200);
    assert.match(await result.text(), /Isolated computer/);
    await assert.rejects(manager.exec(computer.id, ['true']), /computer_human_control/);
    assert.throws(() => manager.handBack(computer.id, authority), /computer_not_in_takeover/);
    await assert.rejects(manager.destroy(computer.id), /computer_transition/);
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { headers: { 'x-fixture-owner': 'yes', host: 'localhost' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(foreignHost, 403);
    const foreignOrigin = connect(session.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { foreignOrigin.once('connect', resolve); foreignOrigin.once('error', reject); });
    const rejectedOrigin = new Promise<string>(resolve => { foreignOrigin.once('data', chunk => { resolve(chunk.toString()); foreignOrigin.destroy(); }); foreignOrigin.once('close', () => resolve('')); });
    foreignOrigin.write(`GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:${session.port}\r\nOrigin: http://localhost:${session.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Fixture-Owner: yes\r\n\r\n`);
    assert.equal(await rejectedOrigin, '');
    const socket = connect(session.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const handshake = new Promise<string>((resolve, reject) => { socket.once('data', data => resolve(data.toString())); socket.once('error', reject); });
    socket.write(`GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:${session.port}\r\nOrigin: http://127.0.0.1:${session.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Fixture-Owner: yes\r\n\r\n`);
    assert.match(await handshake, /^HTTP\/1\.1 101/);
    const disconnected = new Promise<boolean>(resolve => socket.once('close', () => resolve(true)));
    revocation.abort();
    const revoked = await Promise.race([disconnected, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000))]);
    if (!revoked) socket.destroy();
    assert.equal(revoked, true);
    await assert.rejects(session.handBack({}), /unauthorized/);
    const end = manager.endGraphical.bind(manager);
    let calls = 0;
    manager.endGraphical = async (...args) => { if (++calls === 1) throw new Error('fixture_removal_failure'); return end(...args); };
    await assert.rejects(session.handBack(authority), /fixture_removal_failure/);
    assert.equal(manager.get(computer.id).state, 'graphical');
    await assert.rejects(fetch(url), /fetch failed/);
    try { await assert.doesNotReject(session.handBack(authority)); }
    catch (error) {
      const generation = (await manager.inspectRecovery(authority)).computers[0]!.generation!;
      await end(computer.id, generation, authority);
      session = undefined;
      throw error;
    }
    assert.equal(calls, 2);
    session = undefined;
    assert.equal(manager.get(computer.id).state, 'ready');
  } finally {
    if (session) await session.handBack(authority);
    await manager.cleanup(); manager.close(); rmSync(dir, { recursive: true, force: true });
  }
});
