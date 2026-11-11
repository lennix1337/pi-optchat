import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QUOTA_HISTORY_FILE, quotaWindows, readQuotaHistory, sampleQuota, type QuotaRow } from '../src/quota-history.ts';
import { analyzeQuota, baseProvider, intervalsOf, loadEconomy, readCalls, readRates, roleKey, toCall, WEEK_MS, type Call, type RateTable } from '../src/quota-economy.ts';
import { accountLines, accountText, reportText, resetText, weeklyLines, windowText } from '../src/quota-format.ts';
import { quotaCommandText } from '../src/quota-command.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 11, 12, 0); // 11/11 09:00 in Brasília
const tmp = (t: { after(fn: () => void): void }) => { const dir = mkdtempSync(join(tmpdir(), 'quota-tracking-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as QuotaRow);

const cache = (fetchedAt: number, used5h = 5, used7d = 19) => ({
  usageByProvider: {
    anthropic: { plan: 'api-key', fetchedAt },
    'anthropic-account-2': { fetchedAt, primary: { usedPercent: used5h, resetAt: NOW + 3 * HOUR, windowSeconds: 18_000 }, secondary: { usedPercent: used7d, resetAt: NOW + 6 * DAY, windowSeconds: 604_800 } },
  },
});

test('the sampler writes one row per account, with both windows and their resets, and skips an unchanged fetchedAt', t => {
  const dir = tmp(t), file = join(dir, QUOTA_HISTORY_FILE);
  const rows = sampleQuota(dir, cache(NOW - 60_000), NOW);
  assert.deepEqual(rows.map(r => r.provider), ['anthropic', 'anthropic-account-2']);
  assert.deepEqual(lines(file)[1], { at: NOW, provider: 'anthropic-account-2', fetchedAt: NOW - 60_000, w5h: { used: 5, resetAt: NOW + 3 * HOUR }, w7d: { used: 19, resetAt: NOW + 6 * DAY } });
  assert.deepEqual(sampleQuota(dir, cache(NOW - 60_000), NOW + 5 * 60_000), [], 'the same reading again adds nothing');
  assert.equal(lines(file).length, 2);
  // Only the account whose reading moved gets a row.
  const moved = cache(NOW - 60_000); (moved.usageByProvider['anthropic-account-2'] as { fetchedAt: number }).fetchedAt = NOW + 240_000;
  assert.deepEqual(sampleQuota(dir, moved, NOW + 10 * 60_000).map(r => r.provider), ['anthropic-account-2']);
  assert.equal(lines(file).length, 3);
});

test('an api-key account is recorded without percentages and a missing or torn cache writes nothing', t => {
  const dir = tmp(t);
  sampleQuota(dir, cache(NOW), NOW);
  const [apiKey] = lines(join(dir, QUOTA_HISTORY_FILE));
  assert.equal(apiKey!.plan, 'api-key');
  assert.equal('w5h' in apiKey!, false);
  assert.equal('w7d' in apiKey!, false);
  const empty = tmp(t);
  for (const state of [undefined, null, {}, { usageByProvider: 'x' }, { usageByProvider: { a: null, b: { primary: { usedPercent: 5 } }, 'bad id!': { fetchedAt: 1 } } }]) sampleQuota(empty, state, NOW);
  assert.deepEqual(readQuotaHistory(empty), [], 'no fetchedAt, no row; an unsafe id is dropped');
  sampleQuota(empty, { usageByProvider: { c: { fetchedAt: NOW } } }, NOW);
  assert.deepEqual(readQuotaHistory(empty).map(r => r.provider), ['c'], 'a reading with no window is still a window-less row');
});

test('window length decides 5h and 7d; the primary/secondary order is only the fallback; serviceable and cooldown are kept', t => {
  assert.deepEqual(quotaWindows({ primary: { usedPercent: 1, resetAt: 9, windowSeconds: 604_800 }, secondary: { usedPercent: 2, resetAt: 8, windowSeconds: 18_000 } }), { w7d: { used: 1, resetAt: 9 }, w5h: { used: 2, resetAt: 8 } });
  assert.deepEqual(quotaWindows({ primary: { usedPercent: 1, resetAt: 9, windowMinutes: 300 } }), { w5h: { used: 1, resetAt: 9 } });
  assert.deepEqual(quotaWindows({ primary: { usedPercent: 1, resetAt: 9 }, secondary: { usedPercent: 2, resetAt: 8 } }), { w5h: { used: 1, resetAt: 9 }, w7d: { used: 2, resetAt: 8 } });
  const dir = tmp(t);
  sampleQuota(dir, { usageByProvider: { codex: { plan: 'team', serviceable: false, fetchedAt: NOW, secondary: { usedPercent: 100, resetAt: NOW + DAY, windowSeconds: 604_800 } } } }, NOW);
  assert.deepEqual(lines(join(dir, QUOTA_HISTORY_FILE))[0], { at: NOW, provider: 'codex', plan: 'team', fetchedAt: NOW, w7d: { used: 100, resetAt: NOW + DAY }, serviceable: false, blockedUntil: NOW + DAY });
});

test('the history stays bounded: past the size limit the live file rotates to .1 and nothing older is kept', t => {
  const dir = tmp(t), file = join(dir, QUOTA_HISTORY_FILE), max = 2000;
  for (let i = 0; i < 60; i++) sampleQuota(dir, cache(NOW + i * 60_000), NOW + i * 60_000, QUOTA_HISTORY_FILE, max);
  assert.ok(existsSync(`${file}.1`), 'rotated');
  assert.ok(statSync(file).size <= max, `live file ${statSync(file).size}`);
  assert.ok(statSync(`${file}.1`).size <= max);
  const all = readQuotaHistory(dir);
  assert.ok(all.length < 120 && all.length > 10, `${all.length} rows kept of 120`);
  assert.equal(all.at(-1)!.fetchedAt, NOW + 59 * 60_000, 'the newest reading survives');
  assert.deepEqual(all.map(r => r.fetchedAt), [...all.map(r => r.fetchedAt)].sort((a, b) => a - b), 'oldest first across both files');
  // A reading already written is still deduplicated after the file rotated.
  assert.deepEqual(sampleQuota(dir, cache(NOW + 59 * 60_000), NOW + 3_600_000, QUOTA_HISTORY_FILE, max), []);
});

const row = (fetchedAt: number, used: number, resetAt: number, key: 'w5h' | 'w7d' = 'w7d', provider = 'p'): QuotaRow => ({ at: fetchedAt, provider, fetchedAt, [key]: { used, resetAt } });

test('percentage points add up inside one period; a reset or a drop starts a new one and is never a negative delta', () => {
  const reset1 = NOW + 5 * DAY, reset2 = reset1 + 7 * DAY;
  const rows = [row(1, 10, reset1), row(2, 14, reset1), row(3, 20, reset1), row(4, 3, reset2), row(5, 9, reset2), row(6, 5, reset2), row(7, 6, reset2)];
  const intervals = intervalsOf(rows, 'w7d');
  assert.deepEqual(intervals.map(i => i.points), [4, 6, 6, 1], '10→14→20, [reset: 20→3 is no delta], 3→9, [drop 9→5 is no delta], 5→6');
  assert.ok(intervals.every(i => i.points >= 0));
  // A new reset stamp that only jitters by a few seconds is the same period.
  assert.deepEqual(intervalsOf([row(1, 10, reset1), row(2, 12, reset1 + 4000)], 'w7d').map(i => i.points), [2]);
  // A reading without the window (an api-key row) breaks the chain instead of bridging it.
  const gap = [row(1, 10, reset1), { at: 2, provider: 'p', fetchedAt: 2 } as QuotaRow, row(3, 30, reset1)];
  assert.deepEqual(intervalsOf(gap, 'w7d'), []);
});

const call = (at: number, provider: string, usd: number | undefined, tokens = 1000, role = 'main'): Call => ({ at, provider, role: roleKey(role), tokens, usd });

test('US$ and tokens are the calls of that provider inside the consumed intervals, per 1% and for a whole window', () => {
  const reset = NOW + 3 * DAY, rows = [row(1000, 10, reset, 'w7d', 'acc'), row(2000, 12, reset, 'w7d', 'acc'), row(3000, 20, reset + WEEK_MS, 'w7d', 'acc'), row(4000, 21, reset + WEEK_MS, 'w7d', 'acc')];
  const calls = [call(500, 'acc', 99), call(1500, 'acc', 4), call(1600, 'other', 50), call(2500, 'acc', 99), call(3500, 'acc', 1, 500), call(2000, 'acc', 2, 200)];
  const { accounts } = analyzeQuota(rows, calls, 5000, 1);
  const w = accounts.find(a => a.provider === 'acc')!.w7d!;
  assert.equal(w.points, 3, '10→12 and 20→21; the reset between 12 and 20 counts nothing');
  assert.equal(w.usd, 4 + 2 + 1, 'calls at 1500 and 2000 (interval one, end inclusive) and 3500; 2500 falls in the reset gap, 1600 is another account');
  assert.equal(w.tokens, 1000 + 200 + 500);
  assert.ok(Math.abs(w.usdPerPoint! - 7 / 3) < 1e-12);
  assert.ok(Math.abs(w.fullWindowUsd! - 700 / 3) < 1e-9);
});

test('a flat window (a spent account at 100%) has no US$ per 1%, never NaN or Infinity', () => {
  const reset = NOW + DAY, rows = [row(1000, 100, reset, 'w7d', 'codex'), row(2000, 100, reset, 'w7d', 'codex'), row(3000, 100, reset, 'w7d', 'codex')];
  const w = analyzeQuota(rows, [call(1500, 'codex', 3)], 5000, 1).accounts[0]!.w7d!;
  assert.equal(w.points, 0);
  assert.equal(w.usdPerPoint, undefined);
  assert.equal(w.fullWindowUsd, undefined);
  assert.match(reportText({}, analyzeQuota(rows, [], 5000, 1)), /sem pontos consumidos ainda/);
});

test('an api-key account has no window figures at all, and an account with no history yet is listed from the cache', () => {
  const apiKey: QuotaRow = { at: 1, provider: 'anthropic', plan: 'api-key', fetchedAt: 1 };
  const eco = analyzeQuota([apiKey, { ...apiKey, at: 2, fetchedAt: 2 }], [call(1500, 'anthropic', 5)], NOW, 1, ['codex']);
  const anthropic = eco.accounts.find(a => a.provider === 'anthropic')!;
  assert.equal(anthropic.w5h, undefined);
  assert.equal(anthropic.w7d, undefined);
  assert.deepEqual(eco.accounts.map(a => a.provider), ['anthropic', 'codex']);
  assert.equal(eco.accounts[1]!.w7d, undefined);
});

const RATES: RateTable = new Map([
  ['openai-codex/gpt-6.1-sol', { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] }],
]);
const record = (provider: string, model: string, usage: Record<string, unknown>, total = 0, role = 'main') => ({ date: new Date(NOW).toISOString(), role, provider, model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage, cost: { total } } });

test('a call recorded at cost 0 is priced from the model registry; a model the registry lacks stays unpriced, with its tokens', () => {
  const free = toCall(record('openai-codex-account-2', 'gpt-6.1-sol', { input: 1_000_000, output: 100_000, cacheRead: 2_000_000 }), RATES)!;
  assert.equal(baseProvider('openai-codex-account-2'), 'openai-codex');
  assert.equal(free.provider, 'openai-codex-account-2', 'the call stays on its own account');
  assert.ok(Math.abs(free.usd! - 5.9) < 1e-9, '3M input tokens in the request are over the 272k tier: 1M x $4 + 100k x $15 + 2M x $0.2');
  const small = toCall(record('openai-codex', 'gpt-6.1-sol', { input: 100_000, output: 10_000, cacheRead: 100_000 }), RATES)!;
  assert.equal(small.usd, (100_000 * 2 + 10_000 * 10 + 100_000 * 0.1) / 1e6, 'below the tier: base prices');
  const tiered = toCall(record('openai-codex', 'gpt-6.1-sol', { input: 300_000, output: 10_000 }), RATES)!;
  assert.equal(tiered.usd, (300_000 * 4 + 10_000 * 15) / 1e6, 'a request over 272k input tokens is billed at the tier price');
  const unknown = toCall(record('openai-codex', 'gpt-mystery', { input: 5000 }), RATES)!;
  assert.equal(unknown.usd, undefined);
  assert.equal(unknown.tokens, 5000);
  assert.equal(toCall(record('anthropic', 'claude-opus-5-5', { input: 10 }, 1.5), RATES)!.usd, 1.5, 'a recorded cost wins over the registry');
  assert.equal(toCall(record('anthropic', 'x', {}), RATES)!.usd, 0, 'a call with no tokens costs nothing');
  assert.equal(toCall({ date: 'nope', usage: { input: 1 } }, RATES), undefined);
});

test('unpriced tokens keep US$ per 1% unknown and report tokens per 1% instead of a made-up figure', () => {
  const reset = NOW + DAY, rows = [row(1000, 0, reset, 'w7d', 'codex'), row(2000, 5, reset, 'w7d', 'codex')];
  const w = analyzeQuota(rows, [call(1500, 'codex', undefined, 5000), call(1600, 'codex', 1, 1000)], 5000, 1).accounts[0]!.w7d!;
  assert.equal(w.usdPerPoint, undefined);
  assert.equal(w.unpricedTokens, 5000);
  assert.equal(w.tokensPerPoint, 6000 / 5);
  assert.match(reportText({ usageByProvider: { codex: {} } }, analyzeQuota(rows, [call(1500, 'codex', undefined, 5000)], 5000, 1)), /sem preço para 5k tokens \(1k tokens por 1%\)/);
});

test('the weekly comparison splits the last 7 days and the 7 before by account and by role, with window edges counted once', () => {
  const calls = [
    call(NOW - 1000, 'acc', 10, 100, 'main'), call(NOW - DAY, 'acc', 5, 50, 'subagent'), call(NOW - 2 * DAY, 'acc', 2, 20, 'compactor'), call(NOW - 3 * DAY, 'acc', 1, 10, 'advisor'),
    call(NOW - WEEK_MS, 'acc', 100, 1000, 'main'), // exactly 7 days ago: the previous week (its end is inclusive)
    call(NOW - WEEK_MS - DAY, 'acc', 20, 200, 'main'), call(NOW - WEEK_MS - 2 * DAY, 'acc2', 30, 300, 'subagent'),
    call(NOW - 2 * WEEK_MS, 'acc', 1000, 1, 'main'), // exactly 14 days ago: before both weeks
    call(NOW - DAY, '', 0.5, 5, 'heartbeat'),
  ];
  const rows = [row(NOW - 3 * DAY, 10, NOW + DAY, 'w7d', 'acc'), row(NOW - 2 * DAY, 18, NOW + DAY, 'w7d', 'acc'), row(NOW - WEEK_MS - 3 * DAY, 1, NOW - 6 * DAY, 'w7d', 'acc'), row(NOW - WEEK_MS - 2 * DAY, 4, NOW - 6 * DAY, 'w7d', 'acc')];
  const [last, before] = analyzeQuota(rows, calls, NOW, 2).weeks;
  assert.equal(last!.byAccount.acc!.spend.usd, 18);
  assert.deepEqual(Object.fromEntries(Object.entries(last!.byAccount.acc!.byRole).map(([k, v]) => [k, v.usd])), { main: 10, subagent: 5, compactor: 2, other: 1 }, 'advisor counts under other');
  assert.equal(last!.byAccount.acc!.points7d, 8);
  assert.equal(before!.byAccount.acc!.spend.usd, 120);
  assert.equal(before!.byAccount.acc!.points7d, 3);
  assert.equal(before!.byAccount.acc2!.byRole.subagent.tokens, 300);
  assert.equal(last!.byRole.other.usd, 1.5, 'roles outside main/subagent/compactor, with or without an account');
  assert.equal(last!.unattributed.usd, 0.5, 'a call with no provider is shown apart, not under an account');
  assert.equal(before!.byRole.main.usd, 120);
  const text = weeklyLines(analyzeQuota(rows, calls, NOW, 2)).join('\n');
  assert.match(text, /acc: US\$18\.00 \(antes US\$120\.00\) · 7d: \+8 pts \(antes \+3\)/);
  assert.match(text, /Por papel: main US\$10\.00 \(antes US\$120\.00\) · subagent US\$5\.00 \(antes US\$30\.00\)/);
});

test('usage.jsonl is read from its tail: only calls after `since`, across chunk boundaries, ignoring torn lines', t => {
  const dir = tmp(t), file = join(dir, 'usage.jsonl'), pad = 'x'.repeat(250);
  const total = 30_000;
  const out: string[] = [];
  for (let i = 0; i < total; i++) out.push(JSON.stringify({ id: i, date: new Date(NOW - (total - i) * 1000).toISOString(), role: 'main', provider: 'p', model: 'm', pad, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0.5 } } }));
  out.splice(total - 5, 0, '{"date":"torn');
  writeFileSync(file, out.join('\n') + '\n');
  assert.ok(statSync(file).size > 8 << 20, 'bigger than two chunks');
  const some = readCalls(file, NOW - 100 * 1000 - 1, new Map());
  assert.equal(some.length, 100 + 0, 'the last 100 calls (one second apart)');
  assert.equal(readCalls(file, 0, new Map()).length, total, 'the whole file, torn line skipped');
  assert.deepEqual(readCalls(join(dir, 'missing.jsonl'), 0, new Map()), []);
  assert.deepEqual(readCalls(file, NOW + 1000, new Map()), []);
});

test('reset times are Brasília time (UTC-3): the clock for today, the date for another day, even when UTC is already tomorrow', () => {
  assert.equal(resetText(NOW + 3 * HOUR, NOW), '12:00');
  assert.equal(resetText(Date.UTC(2026, 10, 12, 1, 30), NOW), '22:30', '01:30 UTC on the 12th is still the 11th in Brasília');
  assert.equal(resetText(Date.UTC(2026, 10, 12, 3, 30), NOW), '12/11 00:30', 'midnight Brasília starts a new day');
  assert.equal(resetText(NOW + 3 * HOUR, NOW, true), '11/11 12:00', 'a 7d reset always carries its date');
  assert.equal(windowText('5h', { used: 5, resetAt: NOW + 3 * HOUR }, NOW), '5h 5% usado, renova 12:00');
  assert.equal(windowText('7d', { used: 19, resetAt: NOW + 6 * DAY }, NOW), '7d 19% usado, renova 17/11 09:00');
  assert.equal(windowText('5h', { used: 12.34, resetAt: NOW - 1 }, NOW), '5h 12.3% na última leitura (janela já renovou)', 'an old reading is not shown as current use');
  assert.equal(windowText('7d', undefined, NOW), undefined);
});

test('each account line shows both windows with resets, API key and no-data accounts say so, an exhausted one says until when', () => {
  const state = {
    usageByProvider: {
      anthropic: { plan: 'api-key', fetchedAt: NOW },
      'anthropic-account-2': { fetchedAt: NOW, primary: { usedPercent: 5, resetAt: NOW + 3 * HOUR, windowSeconds: 18_000 }, secondary: { usedPercent: 19, resetAt: NOW + 6 * DAY, windowSeconds: 604_800 } },
      'openai-codex': { plan: 'team', serviceable: false, fetchedAt: NOW, primary: { usedPercent: 0, resetAt: NOW + HOUR, windowSeconds: 18_000 }, secondary: { usedPercent: 100, resetAt: NOW + 2 * DAY, windowSeconds: 604_800 } },
      empty: {},
    },
    exhaustedUntilByProvider: { cooldown: NOW + 2 * HOUR },
  };
  assert.equal(accountText('anthropic', state, NOW), 'API key, sem limite de cota');
  assert.equal(accountText('anthropic-account-2', state, NOW), '5h 5% usado, renova 12:00 · 7d 19% usado, renova 17/11 09:00');
  assert.equal(accountText('openai-codex', state, NOW), '5h 0% usado, renova 10:00 · 7d 100% usado, renova 13/11 09:00 · *esgotada até 13/11 09:00*');
  assert.equal(accountText('empty', state, NOW), 'sem medição');
  assert.equal(accountText('cooldown', state, NOW), 'sem medição de cota · *esgotada até 11/11 11:00*');
  assert.deepEqual(accountLines(state, NOW).map(l => l.split(':')[0]), ['• anthropic', '• anthropic-account-2', '• cooldown', '• empty', '• openai-codex']);
  assert.deepEqual(accountLines({}, NOW), ['sem leitura de cota (o pi-multi-account ainda não mediu nenhuma conta)']);
  const reset = NOW + DAY, eco = analyzeQuota([row(1000, 0, reset, 'w7d', 'anthropic-account-2'), row(2000, 4, reset, 'w7d', 'anthropic-account-2')], [call(1500, 'anthropic-account-2', 10)], NOW, 1);
  assert.match(accountLines(state, NOW, eco).find(l => l.includes('anthropic-account-2'))!, /19% usado, renova 17\/11 09:00 · 1% = US\$2\.50 \(7d\)$/);
});

test('the report and the terminal /cota print every cached account with the same lines, plus history, window economy and weeks', t => {
  const dir = tmp(t), cacheFile = join(dir, 'cache.json');
  writeFileSync(cacheFile, JSON.stringify(cache(NOW)));
  sampleQuota(dir, cache(NOW - 2 * HOUR, 5, 10), NOW - 2 * HOUR);
  sampleQuota(dir, cache(NOW - HOUR, 5, 14), NOW - HOUR);
  writeFileSync(join(dir, 'usage.jsonl'), `${JSON.stringify({ ...record('anthropic-account-2', 'claude-opus-5-5', { input: 10, totalTokens: 10 }, 8), date: new Date(NOW - 90 * 60_000).toISOString() })}\n`);
  const text = quotaCommandText(dir, NOW, cacheFile);
  assert.match(text, /• anthropic: API key, sem limite de cota/);
  assert.match(text, /• anthropic-account-2: 5h 5% usado, renova 12:00 · 7d 19% usado, renova 17\/11 09:00 · 1% = US\$2\.00 \(7d\)/);
  assert.match(text, /7d: \+4 pts em 1 leituras · 10 tokens · US\$2\.00 por 1% → janela cheia US\$200\.00/);
  assert.match(text, /Semana mais recente/);
  assert.match(text, /• anthropic-account-2: US\$8\.00 · 10 tokens · 1 chamadas · cota 7d \+4 pts, 5h \+0 pts · main US\$8\.00/);
  assert.match(text, /Histórico de cota: desde 11\/11 07:00/);
  assert.equal(loadEconomy({ dir, now: NOW, cacheFile, weeks: 1 }).weeks.length, 1);
  assert.match(quotaCommandText(undefined, NOW, cacheFile), /sem limite de cota/);
  appendFileSync(join(dir, QUOTA_HISTORY_FILE), '{torn');
  assert.equal(readQuotaHistory(dir).length, 4, 'a torn tail does not hide the rows before it');
  assert.equal(readRates(join(dir, 'none.json')).size, 0);
});

test('a week that predates the history says so instead of printing 0 points', () => {
  const eco = analyzeQuota([], [call(NOW - DAY, 'acc', 3)], NOW, 1);
  assert.match(reportText({}, eco), /• acc: US\$3\.00 · 1k tokens · 1 chamadas · cota sem histórico nesta semana · main US\$3\.00/);
  assert.match(reportText({}, eco), /Histórico de cota: ainda sem leituras/);
});

test('reading usage.jsonl stops at the first chunk that is entirely older than the window, even when a line has a garbled date', t => {
  const dir = tmp(t), file = join(dir, 'usage.jsonl'), pad = 'x'.repeat(250);
  const make = (at: number) => JSON.stringify({ date: new Date(at).toISOString(), role: 'main', provider: 'p', model: 'm', pad, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 1 } } });
  const out = [make(NOW - 10 * HOUR)]; // an in-range record far back, out of order: only reachable if the reader did not stop
  for (let i = 0; i < 22_000; i++) out.push(i === 12_000 ? '{"date":"zzz-not-a-date","pad":"' + pad + '"}' : make(NOW - 30 * DAY));
  out.push(make(NOW - 1000));
  writeFileSync(file, out.join('\n') + '\n');
  assert.ok(statSync(file).size > 2 * (4 << 20) && statSync(file).size < 3 * (4 << 20), 'three chunks: the newest, the garbled one, the one holding the early record');
  assert.deepEqual(readCalls(file, NOW - DAY, new Map()).map(c => c.at), [NOW - 1000], 'stopped at the old chunk');
});

test('a reading with no fetchedAt is never written, even after the account has history', t => {
  const dir = tmp(t);
  sampleQuota(dir, cache(NOW), NOW);
  const broken = cache(NOW); delete (broken.usageByProvider['anthropic-account-2'] as { fetchedAt?: number }).fetchedAt;
  assert.deepEqual(sampleQuota(dir, broken, NOW + 1), []);
  assert.equal(readQuotaHistory(dir).length, 2);
});
