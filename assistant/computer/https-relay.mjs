// Runs only inside the network-none browser. STDIO is the sole external transport.
import http from 'node:http';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { relayReadHeaders, relayConnectTarget } from './relay-policy.mjs';

process.umask(0o077);
let certificateDirectory;
let trustImported = false;
let stopping = false;
const pending = new Map();
const sockets = new Set();
let nextId = 0;
let configured = false;
let proxy;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
function run(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) throw new Error('relay_certificate_setup_failed');
}
function certificates(origins) {
  const dir = '/work/egress-ca';
  mkdirSync(dir, { mode: 0o700 });
  certificateDirectory = dir;
  run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=OptChat disposable browser CA', '-keyout', `${dir}/ca.key`, '-out', `${dir}/ca.crt`]);
  const contexts = new Map();
  for (let i = 0; i < origins.length; i++) {
    const host = new URL(origins[i]).hostname;
    // Fixed DNS names only. IP origins are deliberately unsupported by this browser seam.
    if (!/^[a-z0-9.-]+$/.test(host) || /^[0-9.]+$/.test(host)) throw new Error('relay_invalid_origin');
    const file = `${dir}/${i}`;
    writeFileSync(`${file}.ext`, `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
    run(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${host}`, '-keyout', `${file}.key`, '-out', `${file}.csr`]);
    run(['openssl', 'x509', '-req', '-in', `${file}.csr`, '-CA', `${dir}/ca.crt`, '-CAkey', `${dir}/ca.key`, '-set_serial', String(i + 1), '-days', '1', '-extfile', `${file}.ext`, '-out', `${file}.crt`]);
    contexts.set(`${host}:443`, { origin: origins[i], context: tls.createSecureContext({ key: readFileSync(`${file}.key`), cert: readFileSync(`${file}.crt`), minVersion: 'TLSv1.2' }) });
  }
  mkdirSync('/work/.pki/nssdb', { recursive: true, mode: 0o700 });
  if (!existsSync('/work/.pki/nssdb/cert9.db')) run(['certutil', '-N', '-d', 'sql:/work/.pki/nssdb', '--empty-password']);
  run(['certutil', '-A', '-d', 'sql:/work/.pki/nssdb', '-n', 'OptChat disposable', '-t', 'C,,', '-i', `${dir}/ca.crt`]);
  trustImported = true;
  return { contexts, fingerprint: createHash('sha256').update(readFileSync(`${dir}/ca.crt`)).digest('hex') };
}
function deny(response) { response.writeHead(403, { connection: 'close' }); response.end('Blocked by disposable browser policy'); }
function forward(origin, req, res) {
  const headers = relayReadHeaders(origin, req, pending.size, nextId);
  if (!headers) return deny(res);
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); res.destroy(new Error('relay_timeout')); }, 20_000);
  pending.set(id, { res, timer, method: req.method });
  res.on('close', () => { clearTimeout(timer); pending.delete(id); });
  send({ id, url: origin + req.url, method: req.method, headers });
}
function start(origins) {
  if (!Array.isArray(origins) || !origins.length || origins.length > 16 || origins.some(origin => typeof origin !== 'string' || !/^https:\/\/[^/:?#]+$/.test(origin))) throw new Error('relay_invalid_origins');
  const { contexts, fingerprint } = certificates(origins);
  proxy = http.createServer({ maxHeaderSize: 16_384 }, (_req, res) => deny(res));
  proxy.on('connect', (req, socket, head) => {
    const target = relayConnectTarget(req.url, head, contexts);
    if (!target) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: target.context, ALPNProtocols: ['http/1.1'] });
    secure.setTimeout(20_000, () => secure.destroy());
    secure.on('error', () => secure.destroy());
    const server = http.createServer({ maxHeaderSize: 16_384 }, (r, s) => forward(target.origin, r, s));
    server.on('upgrade', (_r, s) => s.destroy());
    server.on('connect', (_r, s) => s.destroy());
    server.on('clientError', (_e, s) => s.destroy());
    server.emit('connection', secure);
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy()); });
  proxy.on('clientError', (_e, socket) => socket.destroy());
  proxy.listen(0, '127.0.0.1', () => send({ ready: true, port: proxy.address().port, fingerprint }));
}
function reply(value) {
  const entry = pending.get(value.id);
  if (!entry) return;
  pending.delete(value.id);
  clearTimeout(entry.timer);
  if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599 || typeof value.body !== 'string' || value.body.length > 2_800_000) return entry.res.destroy();
  const body = Buffer.from(value.body, 'base64');
  entry.res.writeHead(value.status, { ...value.headers, 'content-length': body.length, connection: 'close' });
  entry.res.end(entry.method === 'HEAD' ? undefined : body);
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  try {
    if (line.length > 2_850_000) throw new Error('relay_frame_too_large');
    const value = JSON.parse(line);
    if (!configured) { configured = true; start(value.origins); }
    else reply(value);
  } catch (error) { process.stderr.write(String(error.message) + '\n'); shutdown(); process.exitCode = 1; }
});
function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    if (trustImported) run(['certutil', '-D', '-d', 'sql:/work/.pki/nssdb', '-n', 'OptChat disposable']);
    if (certificateDirectory) rmSync(certificateDirectory, { recursive: true });
  } catch { process.stderr.write('relay_ca_cleanup_failed\n'); process.exitCode = 1; }
  for (const { timer, res } of pending.values()) { clearTimeout(timer); res.destroy(); }
  for (const socket of sockets) socket.destroy();
  proxy?.close();
  lines.close();
  process.stdin.destroy();
}
lines.on('close', shutdown);
process.on('SIGTERM', shutdown);
