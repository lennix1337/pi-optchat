import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { dockerCli } from '../src/computer/docker.ts';
import { ComputerManager } from '../src/computer/manager.ts';
import { beginGraphicalTakeover } from '../src/computer/graphical-takeover.ts';
import { onTakeoverDisplay } from '../src/computer/takeover-session.ts';
import { connectOperator, KEYSYMS } from './takeover-operator.ts';

const PASSWORD = `pw-${randomBytes(9).toString('hex')}`;
/** A disposable login site that lives and runs inside the agent's own network-none container (127.0.0.1:8080). */
const SITE = `
const sessions = new Set();
require('node:http').createServer((req, res) => {
  const sid = /(?:^|; )sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const form = new URLSearchParams(body);
      if (form.get('user') === 'operator' && form.get('pass') === ${JSON.stringify(PASSWORD)}) {
        const session = require('node:crypto').randomBytes(12).toString('hex'); sessions.add(session);
        res.writeHead(303, { 'set-cookie': 'sid=' + session + '; HttpOnly; Path=/', location: '/' }).end();
      } else res.writeHead(401).end('denied');
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  if (sid && sessions.has(sid)) res.end('<title>Account</title><h1>Welcome operator</h1>');
  else res.end('<title>Login</title><h1>Sign in</h1><form method=post action=/login><input name=user autofocus style="width:600px;height:60px"><br><input name=pass type=password style="width:600px;height:60px"><br><button style="width:200px;height:60px">Go</button></form>');
}).listen(8080, '127.0.0.1');`;

const files = (dir: string): string[] => readdirSync(dir).flatMap(name => statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]);

test('operator logs in through takeover of the agent\'s own browser and the agent continues authenticated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takeover-login-'));
  const authority = {}, owner = `login-${randomUUID()}`, token = randomBytes(24).toString('hex'), expiresAt = Date.now() + 120_000;
  const manager = new ComputerManager({ databasePath: join(dir, 'state.sqlite'), owner, image: 'optchat-computer-takeover:local', operatorAuthority: authority });
  const cookie = `takeover_token=${token}`;
  let session: Awaited<ReturnType<typeof beginGraphicalTakeover>> | undefined;
  try {
    const computer = await manager.create('fixture', 'agent');
    const before = await manager.isolatedTarget(computer.id);
    const start = await dockerCli(['exec', '--detach', '--user', '1000:1000', computer.container, 'node', '-e', SITE]);
    assert.equal(start.code, 0, start.stderr);
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await manager.exec(computer.id, ['wget', '-qO-', 'http://127.0.0.1:8080/'])).code === 0) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const browser = (...args: string[]) => manager.exec(computer.id, onTakeoverDisplay(['agent-browser', '--session', 'agent', ...args]), { timeoutMs: 60_000 });
    const opened = await browser('--headed', 'open', 'http://127.0.0.1:8080/');
    assert.equal(opened.code, 0, opened.stderr);
    const login = await browser('snapshot');
    assert.match(login.stdout, /Sign in/);
    assert.doesNotMatch(login.stdout, /Welcome/);

    session = await beginGraphicalTakeover({ computers: manager, id: computer.id, authority, revocation: new AbortController().signal,
      authorizeOwner: request => request.headers.cookie === cookie && Date.now() < expiresAt });
    assert.equal(manager.get(computer.id).state, 'graphical');
    await assert.rejects(browser('snapshot'), /computer_human_control/);
    const url = `http://127.0.0.1:${session.port}/`;
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { cookie: 'takeover_token=wrong' } })).status, 403);

    const operator = await connectOperator(session.port, { cookie });
    await assert.rejects(connectOperator(session.port, { cookie }), /operator_(upgrade_refused|channel_closed)/);
    const screen = await operator.screen();
    const colours = new Set<number>();
    for (let offset = 0; offset < screen.pixels.length; offset += 4 * 997) colours.add(screen.pixels.readUInt32LE(offset));
    assert.ok(screen.width >= 1024 && colours.size > 2, 'the operator sees a rendered desktop, not a blank screen');
    // Focus the browser window under the pointer, then walk the form with the keyboard like a person would.
    operator.pointer(640, 400); operator.pointer(640, 400, 1); operator.pointer(640, 400);
    await new Promise(resolve => setTimeout(resolve, 300));
    await operator.press(KEYSYMS.Tab);
    await operator.type('operator');
    await operator.press(KEYSYMS.Tab);
    await operator.type(PASSWORD);
    await operator.press(KEYSYMS.Enter);
    await new Promise(resolve => setTimeout(resolve, 1500));
    operator.close(); await operator.closed;

    await session.handBack(authority); session = undefined;
    assert.equal(manager.get(computer.id).state, 'ready');
    assert.equal(await manager.isolatedTarget(computer.id), before, 'the same container, not a replacement');
    const reopened = await browser('open', 'http://127.0.0.1:8080/');
    assert.equal(reopened.code, 0, reopened.stderr);
    const account = await browser('snapshot');
    assert.match(account.stdout, /Welcome operator/);

    const census = await dockerCli(['ps', '--all', '--filter', `label=optchat.computer.owner=${owner}`, '--format', '{{.ID}}']);
    assert.equal(census.stdout.trim().split(/\r?\n/).filter(Boolean).length, 1, 'no second container was created');
    const stopped = await dockerCli(['exec', computer.container, 'sh', '-c', 'pgrep x11vnc; pgrep websockify; true']);
    assert.equal(stopped.stdout.trim(), '', 'the takeover viewer processes are gone after handback');
    for (const file of files(dir)) assert.ok(!readFileSync(file).includes(PASSWORD), `host state ${file} never holds the operator's password`);
  } finally {
    if (session) await session.handBack(authority).catch(() => undefined);
    await manager.cleanup(); manager.close(); rmSync(dir, { recursive: true, force: true });
  }
});
