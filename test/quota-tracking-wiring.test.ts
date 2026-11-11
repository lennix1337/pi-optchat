import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProdHealth, registerProdHealth } from '../src/prod-health.ts';
import { registerQuotaCommand } from '../src/quota-command.ts';
import { QUOTA_HISTORY_FILE, sampleQuota } from '../src/quota-history.ts';
import { updateUsageAggregate } from '../src/usage-aggregate.ts';
import { DailySummary, localDate } from '../src/slack-reports.ts';

const run = promisify(execFile);
const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 11, 12, 0); // 11/11 09:00 in Brasília
const tmp = (t: { after(fn: () => void): void }) => { const dir = mkdtempSync(join(tmpdir(), 'quota-wiring-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const cache = (fetchedAt: number, used7d: number) => ({
  usageByProvider: {
    anthropic: { plan: 'api-key', fetchedAt },
    'anthropic-account-2': { fetchedAt, primary: { usedPercent: 5, resetAt: NOW + 3 * HOUR, windowSeconds: 18_000 }, secondary: { usedPercent: used7d, resetAt: NOW + 6 * DAY, windowSeconds: 604_800 } },
  },
});
const usageLine = (at: number, usd: number, role = 'main', provider = 'anthropic-account-2') => JSON.stringify({ date: new Date(at).toISOString(), role, provider, model: 'claude-opus-5-5', usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { total: usd } } });
const profile = (t: { after(fn: () => void): void }) => {
  const dir = tmp(t), cacheFile = join(dir, 'cache.json');
  writeFileSync(cacheFile, JSON.stringify(cache(NOW, 19)));
  sampleQuota(dir, cache(NOW - 2 * HOUR, 15), NOW - 2 * HOUR);
  sampleQuota(dir, cache(NOW - HOUR, 17), NOW - HOUR);
  writeFileSync(join(dir, 'usage.jsonl'), [usageLine(NOW - 90 * 60_000, 6), usageLine(NOW - 30 * 60_000, 1, 'subagent'), usageLine(NOW - 9 * DAY, 40)].join('\n') + '\n');
  return { dir, cacheFile };
};

test('the 07:00 summary lists every account with both resets and the weekly API-equivalent block next to the harness cost', async t => {
  const { dir, cacheFile } = profile(t);
  await updateUsageAggregate({ dir, now: NOW, ratesFile: join(dir, 'no-prices.json') });
  const posts: string[] = [];
  const daily = new DailySummary(() => ({ dir, name: 'fixture' }), async text => { posts.push(text); }, { open: () => [] } as never, () => 0, {
    at: '00:00', until: 24, now: () => NOW, quotaFile: cacheFile, gh: async () => { throw new Error('offline'); },
    request: async (_owner, path) => path.startsWith('/v1/briefing') ? { localDate: localDate(NOW), items: [], sources: [] } : { tasks: [] },
  });
  assert.equal(await daily.maybePost(), true);
  const text = posts[0]!;
  assert.match(text, /\*Cotas dos modelos\*\n• anthropic: API key, sem limite de cota\n• anthropic-account-2: 5h 5% usado, renova 12:00 · 7d 19% usado, renova 17\/11 09:00 · 1% = US\$3\.00 \(7d\)/);
  const cost = text.slice(text.indexOf('*Custo do harness*'));
  assert.match(cost, /US\$ equivalente em API, últimos 7 dias/);
  assert.match(cost, /anthropic-account-2: US\$7\.00 \(antes US\$40\.00\) · 7d: \+2 pts \(antes \+0\)/);
  assert.match(cost, /Por papel: main US\$6\.00 \(antes US\$40\.00\) · subagent US\$1\.00 \(antes US\$0\.00\)/);
});

test('the health round samples the quota once per round, and a failing sampler does not stop the probes', async t => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'assistant.json'), '{}');
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = { on: () => {}, registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c) };
  const monitor = { health: new ProdHealth({ probes: [{ name: 'p', check: () => ({ ok: true, ms: 0, detail: 'fine' }) }], file: 'p.json', now: () => NOW }), channel: null, wakes: false };
  const sampled: string[] = [];
  let fail = false;
  registerProdHealth(pi as never, () => ({ dir }), async () => {}, () => {}, [monitor], 300_000, d => { sampled.push(d); if (fail) throw new Error('disk full'); });
  const notes: string[] = [];
  const ctx = { ui: { notify: (text: string) => notes.push(text) } };
  await commands.get('optchat-health')!.handler('', ctx);
  fail = true;
  await commands.get('optchat-health')!.handler('', ctx);
  assert.deepEqual(sampled, [dir, dir]);
  assert.equal(notes.length, 2);
  assert.ok(existsSync(join(dir, 'p.json')), 'the probe state was still written after the sampler threw');
});

test('the terminal /cota prints the same table the Slack command does', async t => {
  const { dir, cacheFile } = profile(t);
  // The fixture's windows end hours after NOW; the command reads the clock, so it is pinned there rather than to the day the suite runs.
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  await updateUsageAggregate({ dir, now: NOW, ratesFile: join(dir, 'no-prices.json') });
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  registerQuotaCommand({ registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c) } as never, () => dir, cacheFile);
  assert.deepEqual([...commands.keys()], ['cota']);
  const notes: [string, string][] = [];
  await commands.get('cota')!.handler('', { ui: { notify: (text: string, level: string) => notes.push([text, level]) } });
  assert.equal(notes[0]![1], 'info');
  assert.match(notes[0]![0], /• anthropic: API key, sem limite de cota\n• anthropic-account-2: 5h 5% usado, renova \d\d:\d\d · 7d 19% usado, renova \d\d\/\d\d \d\d:\d\d/);
});

test('quota-report.mjs prints every cached account read-only and rejects bad arguments', async t => {
  const { dir, cacheFile } = profile(t);
  const before = readdirSync(dir).sort();
  const script = join(import.meta.dirname, '..', 'scripts', 'quota-report.mjs');
  const { stdout } = await run(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', pathToFileURL(join(import.meta.dirname, 'fixed-clock.mjs')).href, script, dir, '--weeks', '1', '--cache', cacheFile, '--rates', join(dir, 'none.json')], { env: { ...process.env, FIXED_NOW: String(NOW) } });
  assert.match(stdout, /• anthropic: API key, sem limite de cota/);
  assert.match(stdout, /• anthropic-account-2: 5h 5% usado, renova \d\d:\d\d · 7d 19% usado/);
  assert.match(stdout, /Histórico de cota: desde /);
  assert.match(stdout, /Semana mais recente/);
  assert.doesNotMatch(stdout, /Semana -1/);
  assert.deepEqual(readdirSync(dir).sort(), before, 'nothing written next to the history');
  assert.ok(existsSync(join(dir, QUOTA_HISTORY_FILE)));
  for (const args of [[], [dir, '--weeks', '0'], [dir, '--weeks', 'x'], [dir, 'extra'], [dir, '--nope']]) {
    await assert.rejects(run(process.execPath, ['--experimental-transform-types', '--no-warnings', script, ...args]), (error: { code: number; stderr: string }) => error.code === 2 && /usage: node --experimental-transform-types scripts\/quota-report\.mjs|unknown option/.test(error.stderr), args.join(' '));
  }
});
