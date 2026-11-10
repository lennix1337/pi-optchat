import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounts, quotaProbe, quotaRisks, routeBlock, QUOTA_HEALTH_FILE } from '../src/quota-health.ts';
import { defaultMonitors, ProdHealth, readHealth, registerProdHealth } from '../src/prod-health.ts';
import { DailySummary, localDate } from '../src/slack-reports.ts';

const NOW = Date.parse('2026-10-30T23:00:00Z'); // 20:00 Brasília
const HOUR = 3_600_000;
const window = (usedPercent: number, hours = 1) => ({ usedPercent, resetAt: NOW + hours * HOUR });
const fixture = { usageByProvider: { healthy: { primary: window(10) }, near: { primary: window(20), secondary: window(94, 2) }, spent: { primary: window(100, 3) }, unknown: {} } };

test('cached quota uses the fullest unexpired window, cooldowns, and Brasília reset times', () => {
  assert.deepEqual(accounts({ ...fixture, exhaustedUntilByProvider: { spent: NOW + HOUR, cooldown: NOW + 4 * HOUR, expired: NOW - 1 } }, NOW), [
    { id: 'cooldown', used: undefined, resetAt: undefined, blockedUntil: NOW + 4 * HOUR },
    { id: 'healthy', used: 10, resetAt: NOW + HOUR, blockedUntil: undefined },
    { id: 'near', used: 94, resetAt: NOW + 2 * HOUR, blockedUntil: undefined },
    { id: 'spent', used: 100, resetAt: NOW + 3 * HOUR, blockedUntil: NOW + 3 * HOUR },
  ]);
  assert.deepEqual(quotaRisks(fixture, NOW), ['🪫 cota near em 94% (leitura em cache), renova 30/10 22:00']);
  assert.deepEqual(quotaRisks({ usageByProvider: { boundary: { primary: window(90) }, below: { primary: window(89) } } }, NOW), ['🪫 cota boundary em 90% (leitura em cache), renova 30/10 21:00']);
  assert.deepEqual(accounts(fixture, NOW + 3 * HOUR), []);
  assert.deepEqual(accounts({ usageByProvider: { '<!channel>': { primary: window(100) }, 'api_key-leak': { primary: window(100) }, invalidDate: { primary: { usedPercent: 100, resetAt: 1e30 } } }, exhaustedUntilByProvider: { invalidDate: 1e30 } }, NOW), [], 'unsafe labels and invalid dates must not reach Slack');
});

test('malformed or missing readings remain unknown, never proof of headroom or exhaustion', () => {
  for (const state of [null, [], 1, {}, { usageByProvider: null }, { usageByProvider: { a: null, b: { primary: { usedPercent: '100', resetAt: NOW + HOUR } }, c: { primary: { usedPercent: NaN, resetAt: NOW + HOUR } }, d: { primary: { usedPercent: 100 } }, e: { secondary: window(-1) } }, exhaustedUntilByProvider: { x: 'tomorrow' } }]) {
    assert.deepEqual(accounts(state, NOW), []);
    assert.deepEqual(quotaRisks(state, NOW), []);
  }
});

test('quota probe tolerates missing/corrupt cache and reports exhaustion only for monitored accounts', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-probe-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const probe = quotaProbe(file, () => NOW);
  assert.match((await probe.check()).detail!, /disponibilidade desconhecida/);
  writeFileSync(file, '{broken');
  assert.match((await probe.check()).detail!, /disponibilidade desconhecida/);
  writeFileSync(file, JSON.stringify(fixture));
  assert.equal((await probe.check()).ok, true, 'one exhausted account must not alert while failover has another');
  writeFileSync(file, JSON.stringify({ usageByProvider: { spent: fixture.usageByProvider.spent }, exhaustedUntilByProvider: { cooldown: NOW + HOUR } }));
  assert.match((await probe.check()).problem!, /contas monitoradas esgotadas; a primeira volta 30\/10 21:00/);
});

test('registered quota monitor persists, alerts once without model wake, and reaches the summary forecast', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-flow-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'cache.json');
  writeFileSync(join(dir, 'assistant.json'), '{}');
  writeFileSync(file, JSON.stringify({ exhaustedUntilByProvider: { a: NOW + HOUR } }));
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = { on: () => {}, registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c) };
  const monitor = { health: new ProdHealth({ probes: [quotaProbe(file, () => NOW)], file: QUOTA_HEALTH_FILE, now: () => NOW }), channel: null, wakes: false };
  const posts: string[] = [], wakes: string[] = [];
  registerProdHealth(pi as never, () => ({ dir }), async text => { posts.push(text); }, text => { wakes.push(text); }, [monitor]);
  const ctx = { ui: { notify: () => {} } };
  for (let i = 0; i < 4; i++) await commands.get('optchat-health')!.handler('', ctx);
  assert.equal(posts.length, 1);
  assert.deepEqual(wakes, []);
  assert.equal(readHealth(dir, QUOTA_HEALTH_FILE)['Cota dos modelos']?.down, true);
  writeFileSync(file, JSON.stringify(fixture));
  await commands.get('optchat-health')!.handler('', ctx);
  assert.equal(posts.length, 2, 'recovery is reported once');
  const daily = new DailySummary(() => ({ dir, name: 'fixture' }), async text => { posts.push(text); }, { open: () => [] } as never, () => 0, {
    at: '00:00', until: 24, now: () => NOW, quotaFile: file,
    request: async (_owner, path) => path.startsWith('/v1/briefing') ? { localDate: localDate(NOW), items: [], sources: [] } : { tasks: [] },
  });
  assert.equal(await daily.maybePost(), true);
  const summary = posts.at(-1)!;
  assert.match(summary, /\*Cotas dos modelos\*/);
  assert.match(summary, /cota near em 94%/);
  assert.match(summary, /leitura em cache: healthy 10%/);
  const registered = defaultMonitors().find(m => m.health.file === QUOTA_HEALTH_FILE);
  assert.ok(registered, 'default registered monitor must include quota');
  assert.equal(registered.channel, null);
  assert.equal(registered.wakes, false);
});

test('a route is blocked by what pi-multi-account cached, with its own freshness rules, and free or unknown otherwise', () => {
  const MIN = 60_000, spent = { primary: window(100, 3) };
  assert.equal(routeBlock({}, 'p', 'm', NOW), undefined, 'nothing cached: unknown, not blocked');
  assert.equal(routeBlock(null, 'p', 'm', NOW), undefined);
  assert.equal(routeBlock({ usageByProvider: { p: { primary: window(60) } } }, 'p', 'm', NOW), undefined);
  assert.equal(routeBlock({ usageByProvider: { p: { fetchedAt: NOW - 3 * MIN, serviceable: false } } }, 'p', 'm', NOW), NOW + 7 * MIN, 'a fresh "spent" verdict lasts ten minutes from its snapshot');
  assert.equal(routeBlock({ usageByProvider: { p: { fetchedAt: NOW - 11 * MIN, serviceable: false } } }, 'p', 'm', NOW), undefined, 'a stale verdict blocks nothing');
  assert.equal(routeBlock({ usageByProvider: { p: { fetchedAt: NOW - 3 * MIN, serviceable: false, ...spent } } }, 'p', 'm', NOW), NOW + 3 * HOUR, 'a full window that resets later wins');
  assert.equal(routeBlock({ usageByProvider: { p: { fetchedAt: NOW - HOUR, ...spent } } }, 'p', 'm', NOW), NOW + 3 * HOUR, 'a full window blocks even from a stale snapshot');
  assert.equal(routeBlock({ usageByProvider: { p: { fetchedAt: NOW - 3 * MIN, serviceable: true, ...spent }, }, exhaustedUntilByProvider: { p: NOW + HOUR } }, 'p', 'm', NOW), undefined, 'a fresh "serviceable" frees the provider');
  assert.equal(routeBlock({ usageByProvider: { p: { fetchedAt: NOW - 11 * MIN, serviceable: true, ...spent } } }, 'p', 'm', NOW), NOW + 3 * HOUR, 'a stale "serviceable" frees nothing');
  assert.equal(routeBlock({ exhaustedUntilByProvider: { p: NOW + HOUR, q: NOW - 1 } }, 'p', 'm', NOW), NOW + HOUR);
  assert.equal(routeBlock({ exhaustedUntilByProvider: { q: NOW - 1 } }, 'q', 'm', NOW), undefined, 'a cooldown that ended blocks nothing');
  assert.equal(routeBlock({ exhaustedUntilByModel: { 'p/m': NOW + 2 * HOUR } }, 'p', 'm', NOW), NOW + 2 * HOUR);
  assert.equal(routeBlock({ exhaustedUntilByModel: { 'p/m': NOW + 2 * HOUR } }, 'p', 'other', NOW), undefined, 'a model cooldown stays on its model');
  assert.equal(routeBlock({ usageByProvider: { p: { primary: window(100, 1) } }, exhaustedUntilByProvider: { p: NOW + 4 * HOUR } }, 'p', 'm', NOW), NOW + 4 * HOUR, 'the latest end wins');
  assert.equal(routeBlock({ usageByProvider: { p: { primary: { usedPercent: 100, resetAt: NOW - 1 } } } }, 'p', 'm', NOW), undefined, 'a window that already reset blocks nothing');
});
