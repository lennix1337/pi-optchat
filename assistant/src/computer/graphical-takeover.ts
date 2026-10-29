import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { dockerCli } from './docker.ts';
import type { ComputerManager } from './manager.ts';

export type GraphicalTakeoverOptions = {
  computers: ComputerManager;
  id: string;
  authority: object;
  authorizeOwner: (request: IncomingMessage) => boolean;
  revocation: AbortSignal;
};

/** Trusted host supplies owner authentication; no cookie or URL itself grants authority. */
export async function beginGraphicalTakeover(options: GraphicalTakeoverOptions): Promise<{ port: number; handBack: (authority: object) => Promise<void> }> {
  const { computers, id, authority, authorizeOwner, revocation } = options;
  if (revocation.aborted) throw new Error('takeover_revoked');
  const { generation, target } = await computers.beginGraphical(id, authority);
  try {
    const start = await dockerCli(['exec', '--detach', '--user', '1000:1000', target, 'sh', '/opt/optchat/takeover-session.sh']);
    if (start.code !== 0) throw new Error('takeover_start_failed');
    let ready = false;
    for (let attempt = 0; attempt < 30 && !revocation.aborted; attempt++) {
      const probe = await dockerCli(['exec', '--user', '1000:1000', target, 'sh', '-c', 'pgrep Xvfb >/dev/null && pgrep x11vnc >/dev/null && pgrep chromium >/dev/null && echo | socat - TCP:127.0.0.1:6088 >/dev/null']);
      if (probe.code === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error(revocation.aborted ? 'takeover_revoked' : 'takeover_not_ready');
  } catch (error) {
    try { await computers.endGraphical(id, generation, authority); }
    catch (cleanup) { throw new Error('takeover_cleanup_uncertain', { cause: cleanup }); }
    throw error;
  }
  const clients = new Set<Socket>();
  const children = new Set<ChildProcessWithoutNullStreams>();
  let closing = false;
  let closed: Promise<void> | undefined;
  let teardown: Promise<void> | undefined;
  let finished = false;
  let port = 0;
  const server: Server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  server.on('connection', socket => { if (clients.size >= 16) { socket.destroy(); return; } clients.add(socket); socket.once('close', () => clients.delete(socket)); });
  const revoke = () => { closing = true; for (const socket of clients) socket.destroy(); for (const child of children) child.kill(); };
  revocation.addEventListener('abort', revoke, { once: true });
  if (revocation.aborted) revoke();
  // Each authenticated socket is forwarded through a separate docker exec, never a published port.
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if (closing || request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin !== undefined && request.headers.origin !== `http://127.0.0.1:${port}`) || !authorizeOwner(request) || request.method !== 'GET' || !['/', '/index.html', '/takeover-client.js'].includes(request.url ?? '')) {
      response.writeHead(403); response.end(); return;
    }
    const child = spawn('docker', ['exec', '-i', target, 'socat', '-', 'TCP:127.0.0.1:6088'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.add(child); child.once('close', () => children.delete(child));
    child.stderr.resume(); response.once('close', () => child.kill());
    child.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    child.stdin.end(`GET ${request.url} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    let header = Buffer.alloc(0), ready = false;
    child.stdout.on('data', (data: Buffer) => {
      if (ready) { response.write(data); return; }
      header = Buffer.concat([header, data]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) { if (header.length > 16384) response.destroy(); return; }
      const text = header.subarray(0, end).toString('latin1');
      if (!/^HTTP\/1\.[01] 200\b/.test(text)) { response.writeHead(502); response.end(); return; }
      response.writeHead(200, { 'content-type': request.url === '/takeover-client.js' ? 'application/javascript' : 'text/html', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.write(header.subarray(end + 4)); ready = true;
    });
    child.stdout.on('end', () => { if (!ready && !response.headersSent) response.writeHead(502); response.end(); });
  });
  server.on('upgrade', (request, socket, head) => {
    const origin = `http://127.0.0.1:${port}`;
    if (closing || request.headers.host !== `127.0.0.1:${port}` || !authorizeOwner(request) || request.url !== '/websockify' || request.headers.origin !== origin) { socket.destroy(); return; }
    const child = spawn('docker', ['exec', '-i', target, 'socat', '-', 'TCP:127.0.0.1:6088'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.add(child); child.stderr.resume(); child.once('close', () => { children.delete(child); socket.destroy(); });
    child.on('error', () => socket.destroy());
    const lines = [`GET /websockify HTTP/1.1`, `Host: localhost`, ...Object.entries(request.headers).filter(([key]) => !['host', 'origin', 'cookie', 'authorization'].includes(key)).map(([key, value]) => `${key}: ${value}`), '', ''];
    child.stdin.write(lines.join('\r\n')); if (head.length) child.stdin.write(head);
    socket.pipe(child.stdin); child.stdout.pipe(socket);
    socket.once('close', () => child.kill());
  });
  try {
    if (closing) throw new Error('takeover_revoked');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  } catch (error) {
    revocation.removeEventListener('abort', revoke);
    try { await computers.endGraphical(id, generation, authority); }
    catch (cleanup) { throw new Error('takeover_cleanup_uncertain', { cause: cleanup }); }
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('takeover_listen_failed');
  port = address.port;
  return { port, handBack: async supplied => {
    if (supplied !== authority) throw new Error('unauthorized');
    if (finished) throw new Error('takeover_closed');
    if (!closed) {
      closing = true;
      revocation.removeEventListener('abort', revoke);
      for (const socket of clients) socket.destroy();
      for (const child of children) child.kill();
      closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    try { await closed; } catch (error) { closed = undefined; throw error; }
    if (!teardown) teardown = computers.endGraphical(id, generation, authority);
    try { await teardown; finished = true; }
    catch (error) { teardown = undefined; throw error; }
  } };
}
