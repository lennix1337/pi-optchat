import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advance, DEFAULT_PROBES, healthSignals, registerProdHealth, tellTransitions, FAILURES_BEFORE_ALERT, healthLines, PC_FILE, ProdHealth, readHealth, runProbe, type Fetcher, type HealthState } from '../src/prod-health.ts';
import { QUOTA_HEALTH_FILE } from '../src/quota-health.ts';
import { composeSummary } from '../src/slack-reports.ts';

const [api, web, us] = DEFAULT_PROBES as [typeof DEFAULT_PROBES[0], typeof DEFAULT_PROBES[0], typeof DEFAULT_PROBES[0]];
// Bodies as production served them on 2026-10-30 (trimmed).
const API_OK = '{"status":"ok","timestamp":"2026-10-30T22:11:04.388Z","latency":288,"details":{"db":{"status":"ok"},"ai":{"status":"ok"},"redis":{"status":"ok"}}}';
const WEB_OK = '<!DOCTYPE html><html data-dpl-id="9781524fc90c09a4acfe8f92dc28a6862d548360" class="x" lang="pt-BR"><head>';
const US_OK = '<!doctype html> <html lang="en-US"> <head> <title>Dentai | AI Smile Simulations for Dentists</title>';
const T0 = Date.parse('2026-10-30T22:00:00Z');

test('probes judge content, not only the status code: a degraded subsystem, a blank page and slowness fail', async () => {
  const at = (body: string, status = 200, delay = 0): Fetcher => async () => { clock += delay; return { status, body }; };
  let clock = T0;
  const now = () => clock;
  assert.deepEqual(await runProbe(api, at(API_OK), now), { ok: true, ms: 0 });
  assert.match((await runProbe(api, at(API_OK.replace('"redis":{"status":"ok"}', '"redis":{"status":"down"}')), now)).problem!, /health ok \(redis=down\)/);
  assert.match((await runProbe(api, at('<html>bad gateway</html>', 502), now)).problem!, /HTTP 502/);
  assert.equal((await runProbe(web, at(WEB_OK), now)).build, '9781524fc90c09a4acfe8f92dc28a6862d548360');
  assert.match((await runProbe(web, at('<html><body></body></html>'), now)).problem!, /sem o conteúdo esperado/);
  assert.equal((await runProbe(us, at(US_OK), now)).ok, true);
  assert.match((await runProbe(api, at(API_OK, 200, 4000), now)).problem!, /lento: 4\.0s/);
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  assert.match((await runProbe(api, async () => { throw timeout; }, now)).problem!, /sem resposta em 15s/);
});

test('one blip is not an outage; the second failure alerts once, staying down is silent, recovery is told once', () => {
  const state: HealthState = {};
  const bad = new Map([['API DentAI', { ok: false, ms: 10, problem: 'HTTP 502' }]]), good = new Map([['API DentAI', { ok: true, ms: 120 }]]);
  assert.deepEqual(advance(state, bad, T0), [], 'first failure');
  assert.deepEqual(advance(state, good, T0 + 1), [], 'blip recovered: nothing to tell');
  for (let i = 1; i < FAILURES_BEFORE_ALERT; i++) assert.deepEqual(advance(state, bad, T0 + 2), []);
  const down = advance(state, bad, T0 + 300_000);
  assert.deepEqual(down.map(t => [t.kind, t.text]), [['down', '🔴 API DentAI com problema às 19:05: HTTP 502 (2 checagens seguidas)']]);
  assert.deepEqual(advance(state, bad, T0 + 600_000), [], 'still down: no repeat');
  assert.deepEqual(healthLines(state), ['🔴 API DentAI: HTTP 502 desde 19:05']);
  const up = advance(state, good, T0 + 900_000);
  assert.deepEqual(up.map(t => [t.kind, t.text]), [['recovered', '✅ API DentAI voltou às 19:15 (fora desde 19:05; 120 ms)']]);
  assert.deepEqual(healthLines(state), ['✅ API DentAI (120 ms)']);
});

test('a round probes in parallel, keeps state per profile and feeds the 07:00 summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  try {
    const bodies: Record<string, string> = { [api.url]: API_OK, [web.url]: WEB_OK, [us.url]: US_OK };
    const health = new ProdHealth({ fetcher: async url => ({ status: 200, body: bodies[url]! }), now: () => T0 });
    assert.deepEqual(await health.round(dir), []);
    const lines = healthLines(readHealth(dir));
    assert.deepEqual(lines, ['✅ API DentAI (0 ms)', '✅ Site dentai.com.br (0 ms) · build 9781524f', '✅ Site usdentai.com (0 ms)']);
    assert.match(composeSummary({ day: [], waiting: [], prs: [], approvals: 0, health: lines }), /\*Produção agora\*\n• ✅ API DentAI \(0 ms\)\n• ✅ Site dentai\.com\.br/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registered: /optchat-health test drives the real alert path: #dentai post and one woken turn, marked as a test', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const posts: [string, string | null][] = [], wakes: string[] = [], notices: string[] = [];
  const pi = { on: () => {}, registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c) };
  registerProdHealth(pi as never, () => ({ dir }), async (text, channel) => { posts.push([text, channel]); }, text => { wakes.push(text); });
  try {
    await commands.get('optchat-health')!.handler('test', { ui: { notify: (m: string) => notices.push(m) } });
    assert.deepEqual(posts.map(([t, c]) => [c, /^\[teste de injeção\] 🔴 Sonda de teste com problema às \d\d:\d\d: falha injetada/.test(t)]), [['dentai', true]]);
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!, /controlled injection test/);
    assert.match(wakes[0]!, /do not write to production without the operator's OK/);
    assert.deepEqual(readHealth(dir), {}, 'the test probe keeps its own state, not production\'s');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a recovery is posted without waking anyone; an outage post that fails still wakes', async () => {
  const posts: string[] = [], wakes: string[] = [];
  await tellTransitions([{ probe: 'API DentAI', kind: 'recovered', text: '✅ API DentAI voltou' }], async (text: string) => { posts.push(text); }, (text: string) => { wakes.push(text); });
  assert.deepEqual([posts, wakes], [['✅ API DentAI voltou'], []]);
  await tellTransitions([{ probe: 'API DentAI', kind: 'down', text: '🔴 API DentAI com problema' }], async () => { throw new Error("slack down"); }, (text: string) => { wakes.push(text); });
  assert.equal(wakes.length, 1);
});

test('an outage whose wake fails is said in #dentai, so it is never silent', async () => {
  const posts: string[] = [];
  await tellTransitions([{ probe: 'API DentAI', kind: 'down', text: '🔴 API DentAI com problema' }], async (text: string) => { posts.push(text); }, async () => { throw new Error('session closed'); });
  assert.deepEqual(posts, ['🔴 API DentAI com problema', '🔴 API DentAI com problema (não consegui acordar o agente: veja no terminal)']);
});

test('each monitor transition maps to its own signal kind, severity and occurrence key', () => {
  const at = Date.parse('2026-10-30T22:00:00Z');
  assert.deepEqual(healthSignals('prod-health.json', [{ probe: 'API DentAI', kind: 'down', text: 'API fora', at }]), [{
    source: 'health', kind: 'health.down', severity: 'critical', subject: 'health:prod-health.json:API DentAI',
    summary: 'API fora', dedupeKey: `health:prod-health.json:API DentAI:down:${at}`,
    evidence: 'health:prod-health.json', observedAt: at,
  }]);
  const recovered = healthSignals('prod-health.json', [{ probe: 'API DentAI', kind: 'recovered', text: 'voltou', at }])[0];
  assert.deepEqual([recovered.kind, recovered.severity], ['health.recovered', 'info']);
  const kinds = (file: string, probes: string[]) => probes.map(probe => healthSignals(file, [{ probe, kind: 'down', text: 'x', at }])[0].kind);
  assert.deepEqual(kinds(PC_FILE, ['PC: disco C:', 'PC: memória', 'PC: manutenção diária']), ['pc.disk_low', 'pc.memory_low', 'pc.maintenance_stale']);
  assert.deepEqual(kinds(QUOTA_HEALTH_FILE, ['Cota dos modelos']), ['quota.exhausted']);
  assert.deepEqual([healthSignals(PC_FILE, [{ probe: 'PC: disco C:', kind: 'recovered', text: 'x', at }])[0].kind,
    healthSignals(QUOTA_HEALTH_FILE, [{ probe: 'Cota dos modelos', kind: 'recovered', text: 'x', at }])[0].kind], ['pc.recovered', 'quota.recovered']);
  assert.notEqual(healthSignals('prod-health.json', [{ probe: 'API', kind: 'down', text: 'x', at }])[0].dedupeKey,
    healthSignals('prod-health.json', [{ probe: 'API', kind: 'down', text: 'x', at: at + 1 }])[0].dedupeKey, 'a later outage is a new event');
});
