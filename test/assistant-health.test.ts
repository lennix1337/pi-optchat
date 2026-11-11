import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantProbe, ASSISTANT_HEALTH_FILE, ASSISTANT_PROBE } from '../src/assistant-health.ts';
import { defaultMonitors, FAILURES_BEFORE_ALERT, healthLines, ProdHealth, readHealth, registerProdHealth, tellTransitions, type Monitor, type Transition } from '../src/prod-health.ts';

const T0 = Date.parse('2026-11-11T11:20:00Z'); // 08:20 in Brasília, the morning the service stayed down

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const writeAssistantConfig = (dir: string, port: number) => writeFileSync(join(dir, 'assistant.json'),
  JSON.stringify({ version: 1, profileId: 'work', endpoint: `http://127.0.0.1:${port}`, token: 'health-test-token' }));

/** A stand-in for the assistant service on a disposable port; the real one is never contacted. */
async function withService<T>(run: (dir: string, port: number) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-health-'));
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer health-test-token' || req.url !== '/v1/tasks?limit=1') { res.writeHead(401).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[]}');
  });
  const port = await listen(server);
  writeAssistantConfig(dir, port);
  try { return await run(dir, port); } finally { await close(server).catch(() => undefined); rmSync(dir, { recursive: true, force: true }); }
}
/** A loopback port nothing listens on: what a service that failed to bind (EACCES) looks like from outside. */
async function deadPort(): Promise<number> {
  const server = createServer(); const port = await listen(server); await close(server); return port;
}

test('the probe reads the configured endpoint with its token and fails with the reason when nothing answers', async () => {
  await withService(async (dir, port) => {
    assert.equal((await assistantProbe().check({ dir })).ok, true);
    const dead = await deadPort();
    writeAssistantConfig(dir, dead);
    const down = await assistantProbe().check({ dir });
    assert.equal(down.ok, false);
    assert.match(down.problem!, new RegExp(`^http://127\\.0\\.0\\.1:${dead}: sem conexão \\(ECONNREFUSED\\)$`));
    writeAssistantConfig(dir, port);
    writeFileSync(join(dir, 'assistant.json'), JSON.stringify({ version: 1, profileId: 'work', endpoint: `http://127.0.0.1:${port}`, token: 'wrong-token' }));
    assert.equal((await assistantProbe().check({ dir })).problem, `http://127.0.0.1:${port}: HTTP 401`);
    writeFileSync(join(dir, 'assistant.json'), '{not json');
    assert.deepEqual(await assistantProbe().check({ dir }), { ok: false, ms: 0, problem: 'assistant.json ilegível ou inválido' });
  });
});

test('an unreachable service is down only after two rounds, wakes the agent here and posts nothing to Slack', async () => {
  await withService(async (dir, port) => {
    const dead = await deadPort();
    const health = new ProdHealth({ probes: [assistantProbe()], file: ASSISTANT_HEALTH_FILE, now: () => T0 });
    const monitor = defaultMonitors().find(m => m.health.file === ASSISTANT_HEALTH_FILE) as Monitor;
    assert.ok(monitor, 'the default monitors include the assistant service');
    assert.deepEqual([monitor.channel, monitor.wakes, monitor.slack], [null, true, false]);
    const posts: unknown[] = [], wakes: string[] = [];
    const tell = (t: Transition[]) => tellTransitions(t, async (...args) => { posts.push(args); }, text => { wakes.push(text); }, false, monitor);

    writeAssistantConfig(dir, dead);
    const first = await health.round(dir);
    assert.deepEqual(first, [], 'one missed read is not an outage');
    await tell(first);
    assert.deepEqual(wakes, []);

    const second = await health.round(dir);
    assert.equal(FAILURES_BEFORE_ALERT, 2);
    assert.equal(second.length, 1);
    assert.match(second[0].text, new RegExp(`^🔴 ${ASSISTANT_PROBE} com problema às 08:20: http://127\\.0\\.0\\.1:${dead}: sem conexão \\(ECONNREFUSED\\) \\(2 checagens seguidas\\)$`));
    await tell(second);
    assert.deepEqual(posts, [], 'Slack is what is down: the alert does not go through it');
    assert.equal(wakes.length, 1);
    assert.match(wakes[0], /^\[OptChat health\] 🔴 Assistente local/);
    assert.match(wakes[0], /Slack delivery is down with it/);
    assert.match(wakes[0], /below 49152/);
    assert.doesNotMatch(wakes[0], /#dentai|production/i, 'not the production instructions');

    await tell(await health.round(dir));
    assert.equal(wakes.length, 1, 'still down: one alert, not one per round');

    writeAssistantConfig(dir, port);
    const back = await health.round(dir);
    assert.equal(back[0].kind, 'recovered');
    await tell(back);
    assert.equal(wakes.length, 1, 'a recovery needs no turn');
    assert.deepEqual(posts, []);
    assert.deepEqual(healthLines(readHealth(dir, ASSISTANT_HEALTH_FILE)).map(l => l.replace(/ \(\d+ ms\)$/, '')), [`✅ ${ASSISTANT_PROBE}`]);
  });
});

test('registered: two rounds with the service unreachable deliver one wake and no Slack post', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-health-'));
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = { on: () => {}, registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c) };
  const posts: unknown[] = [], wakes: string[] = [];
  const monitor = defaultMonitors().find(m => m.health.file === ASSISTANT_HEALTH_FILE) as Monitor;
  monitor.health = new ProdHealth({ probes: [assistantProbe()], file: ASSISTANT_HEALTH_FILE, now: () => T0 });
  try {
    writeAssistantConfig(dir, await deadPort());
    registerProdHealth(pi as never, () => ({ dir }), async (...args) => { posts.push(args); }, text => { wakes.push(text); }, [monitor], 300_000, () => undefined);
    const notify = { ui: { notify: () => {} } };
    await commands.get('optchat-health')!.handler('', notify);
    assert.equal(wakes.length, 0);
    await commands.get('optchat-health')!.handler('', notify);
    assert.equal(wakes.length, 1);
    assert.deepEqual(posts, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
