import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { dockerCli } from '../src/computer/docker.ts';
import { ComputerManager } from '../src/computer/manager.ts';
import { beginGraphicalTakeover } from '../src/computer/graphical-takeover.ts';
import { onTakeoverDisplay } from '../src/computer/takeover-session.ts';
import { connectOperator, KEYSYMS } from './takeover-operator.ts';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./takeover-login-continuation.test.ts', import.meta.url), 'utf8');
const SITE_SRC = src.slice(src.indexOf('const SITE = `') + 'const SITE = `'.length, src.indexOf('}).listen(8080, \'127.0.0.1\');`') + '}).listen(8080, \'127.0.0.1\');'.length);
const PASSWORD = 'pw-dev0123456789abcdef';
const SITE = SITE_SRC.replace('${JSON.stringify(PASSWORD)}', JSON.stringify(PASSWORD));
function png(path: string, w: number, h: number, bgra: Buffer) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = bgra[i + 2]!; raw[o + 1] = bgra[i + 1]!; raw[o + 2] = bgra[i]!; }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const out = process.argv[2]!;
const dir = mkdtempSync(join(tmpdir(), 'dev-flow-'));
const authority = {}, owner = `dev-${randomUUID()}`, cookie = 'takeover_token=dev';
const manager = new ComputerManager({ databasePath: join(dir, 's.sqlite'), owner, image: 'optchat-computer-takeover:local', operatorAuthority: authority });
let session;
try {
  const c = await manager.create('f', 'a');
  await dockerCli(['exec', '--detach', '--user', '1000:1000', c.container, 'node', '-e', SITE]);
  await new Promise(r => setTimeout(r, 1500));
  const browser = (...a: string[]) => manager.exec(c.id, onTakeoverDisplay(['agent-browser', '--session', 'agent', ...a]), { timeoutMs: 60_000 });
  console.log('open', (await browser('--headed', 'open', 'http://127.0.0.1:8080/')).code);
  session = await beginGraphicalTakeover({ computers: manager, id: c.id, authority, revocation: new AbortController().signal, authorizeOwner: r => r.headers.cookie === cookie });
  const op = await connectOperator(session.port, { cookie }); await connectOperator(session.port, { cookie }).then(() => console.log('SECOND ACCEPTED'), e => console.log('second refused', e.message));
  let s = await op.screen(); png(join(out, 'a-start.png'), s.width, s.height, s.pixels);
  console.log('screen', s.width, s.height, s.name);
  const step = async (name: string) => { if (process.env.FAST) return; const sc = await op.screen(); png(join(out, name), sc.width, sc.height, sc.pixels); };
  const click = async (x: number, y: number) => { op.pointer(x, y); op.pointer(x, y, 1); await new Promise(r => setTimeout(r, 80)); op.pointer(x, y); await new Promise(r => setTimeout(r, 400)); };
  await click(300, 199); await op.type('operator'); await step('c-user.png');
  await click(300, 259); await op.type(PASSWORD); await step('d-pass.png');
  await click(118, 319); await new Promise(r => setTimeout(r, 1000)); await step('e-enter.png');
  await new Promise(r => setTimeout(r, Number(process.env.WAIT ?? 0))); const dbg = await op.screen(); png(join(out, 'z-final.png'), dbg.width, dbg.height, dbg.pixels); op.close(); await op.closed;
  await session.handBack(authority); session = undefined;
  console.log((await dockerCli(['exec', c.container, 'sh', '-c', 'df -h /tmp /work /dev/shm 2>&1; cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.max; cat /sys/fs/cgroup/memory.events'])).stdout);
  const r = await browser('open', 'http://127.0.0.1:8080/');
  console.log('reopen', r.code, r.stdout, r.stderr); console.log('wget', JSON.stringify(await manager.exec(c.id, ['wget','-qO-','http://127.0.0.1:8080/'])));
  const sn = await manager.exec(c.id, ['agent-browser', '--session', 'agent', 'snapshot']); console.log(sn.stdout);
  const ps = await manager.exec(c.id, ['ps', '-o', 'pid,args']); console.log(ps.stdout.split('\n').filter(l => /Xvfb|x11vnc|websockify|node|agent-browser/.test(l)).map(l => l.slice(0, 120)).join('\n'));
} finally {
  if (session) await session.handBack(authority).catch(e => console.log('handback fail', e.message));
  await manager.cleanup(); manager.close();
}
