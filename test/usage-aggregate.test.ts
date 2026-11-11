import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quotaCommandText } from '../src/quota-command.ts';
import { cachedEconomy, loadEconomy, sampleQuotaRound } from '../src/quota-load.ts';
import { QUOTA_HISTORY_FILE, readQuotaHistory, sampleQuota } from '../src/quota-history.ts';
import { aggregateCalls, readUsageAggregate, updateUsageAggregate, USAGE_AGGREGATE_FILE } from '../src/usage-aggregate.ts';
import { reportText } from '../src/quota-format.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR, MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 11, 12, 0);
const tmp = (t: { after(fn: () => void): void }) => { const dir = mkdtempSync(join(tmpdir(), 'usage-aggregate-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const NO_RATES = '/nonexistent/models-store.json';
const line = (at: number, usd: number | undefined, over: Record<string, unknown> = {}) => JSON.stringify({
  date: new Date(at).toISOString(), role: 'main', provider: 'acc', model: 'm', pad: 'x'.repeat(200),
  usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100, ...usd === undefined ? {} : { cost: { total: usd } } }, ...over,
}) + '\n';
const update = (dir: string, now = NOW) => updateUsageAggregate({ dir, now, ratesFile: NO_RATES });
const cacheOf = (fetchedAt: number, used: number) => ({ usageByProvider: { acc: { fetchedAt, secondary: { usedPercent: used, resetAt: NOW + 6 * DAY, windowSeconds: 604_800 } } } });
const total = (a: { buckets: number[][] }) => a.buckets.reduce((n, b) => n + b[3]!, 0);

test('calls fold into per-minute buckets by provider and role, with unpriced tokens kept apart', async t => {
  const dir = tmp(t), at = NOW - 10 * MINUTE;
  writeFileSync(join(dir, 'usage.jsonl'), line(at, 1) + line(at + 5000, 2) + line(at + 6000, 4, { role: 'subagent' }) + line(at + 7000, undefined, { provider: 'other' }) + line(at + 2 * MINUTE, 3));
  const { aggregate } = (await update(dir))!;
  const calls = aggregateCalls(aggregate);
  const pick = (provider: string, role: string) => calls.filter(c => c.provider === provider && c.role === role);
  assert.deepEqual(pick('acc', 'main').map(c => [c.calls, c.tokens, c.usd]), [[2, 200, 3], [1, 100, 3]], 'two calls in one minute, one two minutes later');
  assert.deepEqual(pick('acc', 'subagent').map(c => [c.calls, c.usd]), [[1, 4]]);
  assert.deepEqual(pick('other', 'main').map(c => [c.tokens, c.usd, c.unpricedTokens]), [[100, 0, 100]], 'no recorded cost and no price: tokens only');
  assert.deepEqual(readUsageAggregate(dir), aggregate, 'saved and read back as written');
});

test('a round reads only the bytes usage.jsonl gained, counts nothing twice and writes nothing when nothing changed', async t => {
  const dir = tmp(t), file = join(dir, 'usage.jsonl');
  let text = '';
  for (let i = 0; i < 40_000; i++) text += line(NOW - HOUR + i * 50, 0.001);
  writeFileSync(file, text);
  assert.ok(statSync(file).size > 8 << 20);
  const first = (await update(dir))!;
  assert.equal(total(first.aggregate), 40_000);
  const grown = line(NOW - 1000, 0.5) + line(NOW - 500, 0.5);
  appendFileSync(file, grown);
  const second = (await update(dir, NOW + 1000))!;
  assert.equal(second.bytesRead, Buffer.byteLength(grown), 'just the new lines');
  assert.equal(total(second.aggregate), 40_002);
  const stamp = statSync(join(dir, USAGE_AGGREGATE_FILE)).mtimeMs;
  const third = (await update(dir, NOW + 2000))!;
  assert.equal(third.bytesRead, 0);
  assert.equal(total(third.aggregate), 40_002, 'the same bytes are never folded twice');
  assert.equal(statSync(join(dir, USAGE_AGGREGATE_FILE)).mtimeMs, stamp, 'unchanged aggregate is not rewritten');
  assert.ok(statSync(join(dir, USAGE_AGGREGATE_FILE)).size < 200_000, 'the aggregate is small next to the log');
});

test('a line still being written is folded once it is complete, not before and not twice', async t => {
  const dir = tmp(t), file = join(dir, 'usage.jsonl'), whole = line(NOW - 1000, 2);
  writeFileSync(file, line(NOW - 2000, 1) + whole.slice(0, 80));
  const a = (await update(dir))!;
  assert.deepEqual(aggregateCalls(a.aggregate).map(c => c.usd), [1], 'the partial line is left for the next round');
  appendFileSync(file, whole.slice(80));
  const b = (await update(dir))!;
  assert.deepEqual(aggregateCalls(b.aggregate).map(c => c.usd), [3]);
  assert.equal(total((await update(dir))!.aggregate), 2);
});

test('a log that was replaced by a shorter one is read again from its tail, and calls past the retention fall out', async t => {
  const dir = tmp(t), file = join(dir, 'usage.jsonl');
  writeFileSync(file, line(NOW - 30 * DAY, 9) + line(NOW - 2 * DAY, 1) + line(NOW - HOUR, 2) + line(NOW - 1000, 3));
  assert.deepEqual(aggregateCalls((await update(dir))!.aggregate).map(c => c.usd), [1, 2, 3], 'older than the retention is not read');
  writeFileSync(file, line(NOW - 500, 7));
  assert.deepEqual(aggregateCalls((await update(dir))!.aggregate).map(c => c.usd), [7], 'the old totals described a log that is gone');
  const later = (await update(dir, NOW + 30 * DAY))!;
  assert.deepEqual(aggregateCalls(later.aggregate), [], 'pruned once it is older than the retention');
  assert.equal(await update(join(dir, 'missing')), undefined);
});

test('the commands never open usage.jsonl: they answer from the profile aggregate even with a huge or unreadable log', async t => {
  const dir = tmp(t), file = join(dir, 'usage.jsonl'), cacheFile = join(dir, 'cache.json');
  let text = '';
  for (let i = 0; i < 40_000; i++) text += line(NOW - 3 * HOUR + i * 200, 0.0001);
  text += line(NOW - 90 * MINUTE, 8);
  writeFileSync(file, text);
  writeFileSync(cacheFile, JSON.stringify(cacheOf(NOW, 19)));
  sampleQuota(dir, cacheOf(NOW - 2 * HOUR, 15), NOW - 2 * HOUR);
  sampleQuota(dir, cacheOf(NOW - HOUR, 17), NOW - HOUR);
  await update(dir);
  // A directory in place of the log: any attempt to read it throws. The aggregate alone must be enough.
  rmSync(file); mkdirSync(file);
  const economy = loadEconomy({ dir, now: NOW, cacheFile, weeks: 1 });
  assert.equal(economy.usageMissing, undefined);
  assert.ok((economy.accounts.find(a => a.provider === 'acc')?.w7d?.usdPerPoint ?? 0) > 0.1, 'US$ per 1% from the aggregate');
  assert.match(quotaCommandText(dir, NOW, cacheFile), /1% = US\$/);
  assert.ok(cachedEconomy(() => dir, 5 * MINUTE, 1, () => NOW, { cacheFile })()?.accounts.length);
  assert.match(reportText({}, loadEconomy({ dir, now: NOW, cacheFile })), /• acc: US\$/);
});

test('without an aggregate yet the commands say so instead of showing zeros, and still list the quotas', t => {
  const dir = tmp(t), cacheFile = join(dir, 'cache.json');
  writeFileSync(cacheFile, JSON.stringify(cacheOf(NOW, 19)));
  writeFileSync(join(dir, 'usage.jsonl'), line(NOW - 1000, 5));
  assert.equal(loadEconomy({ dir, now: NOW, cacheFile }).usageMissing, true);
  const text = quotaCommandText(dir, NOW, cacheFile);
  assert.match(text, /• acc: 7d 19% usado/);
  assert.match(text, /agregado de uso do perfil ainda não existe/);
  assert.doesNotMatch(text, /Semana mais recente/);
});

test('a damaged aggregate is ignored and rebuilt from the tail of the log', async t => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'usage.jsonl'), line(NOW - 1000, 1));
  for (const bad of ['{torn', '{"version":2}', JSON.stringify({ version: 1, offset: 'x', from: 0, providers: [], buckets: [] }), 'null']) {
    writeFileSync(join(dir, USAGE_AGGREGATE_FILE), bad);
    assert.equal(readUsageAggregate(dir), undefined, bad);
  }
  writeFileSync(join(dir, USAGE_AGGREGATE_FILE), JSON.stringify({ version: 1, offset: 0, from: 0, providers: ['a'], buckets: [[1, 0, 0, 1, 1, 1, 0], [1, 7, 0, 1, 1, 1, 0], [1, 0, 'x', 1, 1, 1, 0]] }));
  assert.equal(readUsageAggregate(dir)?.buckets.length, 1, 'buckets pointing nowhere are dropped');
  const rebuilt = (await updateUsageAggregate({ dir, now: NOW, ratesFile: NO_RATES, rebuild: true }))!;
  assert.deepEqual(aggregateCalls(rebuilt.aggregate).map(c => c.usd), [1]);
});

test('the sampler round writes the quota history and the aggregate, and a failure in one does not skip the other', async t => {
  const dir = tmp(t), cacheFile = join(dir, 'cache.json');
  writeFileSync(join(dir, 'usage.jsonl'), line(NOW - 1000, 5));
  writeFileSync(cacheFile, JSON.stringify(cacheOf(NOW - 1000, 12)));
  await sampleQuotaRound(dir, NOW, cacheFile);
  assert.equal(readQuotaHistory(dir, QUOTA_HISTORY_FILE).length, 1);
  assert.equal(aggregateCalls(readUsageAggregate(dir)!).length, 1);
  // The aggregate cannot be built (a directory sits where the file goes), yet the history row is still written and the error surfaces.
  const blocked = tmp(t);
  mkdirSync(join(blocked, USAGE_AGGREGATE_FILE));
  writeFileSync(join(blocked, 'usage.jsonl'), line(NOW - 1000, 5));
  await assert.rejects(sampleQuotaRound(blocked, NOW, cacheFile));
  assert.equal(readQuotaHistory(blocked, QUOTA_HISTORY_FILE).length, 1);
});

test('cachedEconomy loads once per interval and gives undefined without a profile', t => {
  const dir = tmp(t);
  let now = NOW, loads = 0;
  const files = { get cacheFile() { loads++; return join(dir, 'cache.json'); } };
  const economy = cachedEconomy(() => dir, 5 * MINUTE, 1, () => now, files);
  economy(); economy();
  assert.equal(loads, 1);
  now += 5 * MINUTE; economy();
  assert.equal(loads, 2);
  assert.equal(cachedEconomy(() => undefined)(), undefined);
});
