import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { emptyUsage, ranges, UsageLedger, summarizeUsage, type UsageEntry } from '../src/usage.ts';
import { removeDir } from './support.ts';

test('measured response latency persists with the provider-reported call and summarizes as a median', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-latency-'));
  const now = Date.now();
  const call = (timestamp: number): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic-messages', provider: 'anthropic', model: 'm', stopReason: 'stop', timestamp,
    usage: { ...emptyUsage(), input: 10, cacheRead: 90, output: 1, totalTokens: 101 } });
  try {
    const ledger = new UsageLedger(dir);
    const session = SessionManager.inMemory();
    for (const [i, firstMs, responseMs] of [[0, 800, 4000], [1, 1200, 6000], [2, 1000, 5000]]) {
      session.appendMessage(call(now + i));
      ledger.timing(now + i, { firstMs, responseMs });
    }
    session.appendMessage(call(now + 3)); // unmeasured calls stay valid and are left out of the median
    ledger.timing(now + 9, { firstMs: -1, responseMs: Number.NaN });
    ledger.backfill(session.getEntries(), session.getSessionId());
    const reloaded = new UsageLedger(dir);
    assert.equal(reloaded.entries.length, 4);
    assert.deepEqual(reloaded.entries[1].latency, { firstMs: 1200, responseMs: 6000 });
    assert.equal(reloaded.entries[3].latency, undefined);
    const { groups, latency } = summarizeUsage(reloaded.entries);
    assert.deepEqual(latency, { calls: 3, firstMs: 1000, responseMs: 5000 });
    assert.deepEqual(groups[0].latency, { calls: 3, firstMs: 1000, responseMs: 5000 });
    appendFileSync(join(dir, 'usage.jsonl'), JSON.stringify({ ...reloaded.entries[0], id: 'bad-latency', latency: { firstMs: -5 } }) + '\n');
    assert.equal(new UsageLedger(dir).entries.length, 4, 'a negative latency is an invalid record, not a measurement');
  } finally { removeDir(dir); }
});

test('the ledger keeps the 1-hour share of cache writes the provider reported, so 1h and 5m writes can be told apart later', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-1h-'));
  const now = Date.now();
  const call = (timestamp: number, cacheWrite1h?: number): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic-messages', provider: 'anthropic', model: 'm', stopReason: 'stop', timestamp,
    usage: { ...emptyUsage(), input: 10, cacheWrite: 900, output: 1, totalTokens: 911, ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }) } });
  try {
    const session = SessionManager.inMemory();
    session.appendMessage(call(now, 600));
    session.appendMessage(call(now + 1));
    new UsageLedger(dir).backfill(session.getEntries(), session.getSessionId());
    const [long, plain] = new UsageLedger(dir).entries;
    assert.equal(long.usage.cacheWrite1h, 600);
    assert.equal('cacheWrite1h' in plain.usage, false, 'a provider that reports no 1h share gets no invented zero');
    appendFileSync(join(dir, 'usage.jsonl'), JSON.stringify({ ...long, id: 'bad-1h', usage: { ...long.usage, cacheWrite1h: -1 } }) + '\n');
    assert.equal(new UsageLedger(dir).entries.length, 2, 'a negative 1h share is an invalid record');
  } finally { removeDir(dir); }
});

test('usage keeps roles/sessions separate, includes caches, and survives replay and a torn legacy record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-'));
  const now = Date.now();
  const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Done' }], api: 'anthropic-messages', provider: 'anthropic', model: 'test', stopReason: 'stop', timestamp: now,
    usage: { ...emptyUsage(), input: 10, output: 5, cacheRead: 100, cacheWrite: 20, totalTokens: 135, cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.03, total: 0.061 } } };
  try {
    writeFileSync(join(dir, 'usage.jsonl'), JSON.stringify({ date: new Date(now - 2 * 3600_000).toISOString(), role: 'compactor', model: 'old', usage: message.usage }) + '\n{"torn":');
    let ledger = new UsageLedger(dir);
    assert.equal(ledger.warnings.length, 1);
    const session = SessionManager.inMemory(); session.appendMessage(message);
    ledger.backfill(session.getEntries(), session.getSessionId());
    ledger.backfill(session.getEntries(), session.getSessionId());
    const child = SessionManager.inMemory(); child.appendMessage(message);
    ledger.backfill(child.getEntries(), session.getSessionId(), 'subagent', 'child-1');
    ledger.compression(message, 'import', session.getSessionId());
    assert.equal(ledger.entries.length, 4);
    const total = summarizeUsage(ledger.select('This session', session.getSessionId(), now + 1000));
    assert.equal(total.total.totalTokens, 405);
    assert.equal(total.total.cacheRead, 300);
    assert.equal(total.groups.length, 3);
    assert.ok(Math.abs(total.total.cost.total - 0.183) < 1e-9);
    assert.equal(ledger.select('Last hour', '', now + 1000).length, 3);
    assert.equal(ledger.select('All time', '', now + 1000).length, 4);
    assert.equal(ledger.select('This session', 'unrelated-session').length, 0);
    ledger = new UsageLedger(dir);
    ledger.backfill(session.getEntries(), session.getSessionId());
    assert.equal(ledger.entries.length, 4, 'old torn record must not swallow the next append, or replay duplicate it');
    appendFileSync(join(dir, 'usage.jsonl'), JSON.stringify({ date: new Date().toISOString(), role: 'main', model: 'bad', usage: { ...message.usage, input: -5 } }) + '\n');
    assert.equal(new UsageLedger(dir).entries.length, 4);
  } finally { removeDir(dir); }
});

test('aggregation keeps provider identity and still reads legacy records without it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-providers-'));
  const now = Date.now(), usage = { ...emptyUsage(), totalTokens: 10, cost: { ...emptyUsage().cost, total: 0.001 } };
  try {
    writeFileSync(join(dir, 'usage.jsonl'), JSON.stringify({ date: new Date(now).toISOString(), role: 'main', model: 'shared', usage }) + '\n');
    let ledger = new UsageLedger(dir);
    ledger.add({ date: new Date(now).toISOString(), role: 'main', provider: 'provider-a', model: 'shared', usage });
    ledger.add({ date: new Date(now).toISOString(), role: 'main', provider: 'provider-b', model: 'shared', usage });
    ledger = new UsageLedger(dir);
    const summary = summarizeUsage(ledger.entries);
    assert.deepEqual(summary.groups.map(({ provider, model }) => [provider, model]), [
      [undefined, 'shared'], ['provider-a', 'shared'], ['provider-b', 'shared'],
    ]);
    assert.equal(summary.total.cost.total, 0.003);
    assert.equal(summary.total.totalTokens, 30);
    assert.deepEqual(ledger.warnings, []);
  } finally { removeDir(dir); }
});

test('new usage records correlate failed zero-output attempts without persisting arbitrary metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-incident-usage-'));
  const date = new Date().toISOString(), source = emptyUsage();
  const reported = { ...source, input: 12, totalTokens: 12, cost: { ...source.cost, input: 0.02, total: 0.02 }, rawPrompt: 'SECRET PROMPT' } as typeof source;
  try {
    writeFileSync(join(dir, 'usage.jsonl'), JSON.stringify({ date, role: 'main', model: 'legacy-model', usage: source }) + '\n');
    const ledger = new UsageLedger(dir);
    const common = { date, role: 'compactor' as const, provider: 'anthropic', model: 'claude-haiku-5-5', session: 'session-1',
      incidentId: 'incident-42', recoveryIncidentId: 'recovery-77', kind: 'compaction' as const, outcome: 'error' as const, failed: true, errorCategory: 'other' as const, usage: reported };
    ledger.add({ ...common, id: 'attempt-1', attempt: 1 });
    ledger.add({ ...common, id: 'attempt-2', attempt: 2 });
    const summary = summarizeUsage(ledger.entries);
    const compactor = summary.groups.find(group => group.role === 'compactor');
    assert.equal(compactor?.failures, 2);
    assert.equal(summary.failures, 2);
    assert.equal(compactor?.usage.output, 0, 'failed calls can report input/cost while producing no output');
    assert.equal(compactor?.usage.input, 24);
    assert.equal(summary.total.totalTokens, 24 + source.totalTokens);
    assert.equal(ledger.entries[1].incidentId, ledger.entries[2].incidentId);
    assert.equal(ledger.entries[1].recoveryIncidentId, ledger.entries[2].recoveryIncidentId);
    assert.equal(ledger.entries[1].recoveryIncidentId, 'recovery-77');
    assert.equal(ledger.entries[1].attempt, 1);
    assert.equal(ledger.entries[2].attempt, 2);
    const persisted = readFileSync(join(dir, 'usage.jsonl'), 'utf8');
    assert.doesNotMatch(persisted, /SECRET PROMPT|rawPrompt/);
    assert.equal(new UsageLedger(dir).entries.length, 3, 'legacy records remain readable beside attributed records');
  } finally { removeDir(dir); }
});

test('compaction usage callback keeps local attempt and root recovery IDs separate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-root-'));
  const ledger = new UsageLedger(dir), usage = emptyUsage();
  const message: AssistantMessage = { role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-haiku-5-5',
    stopReason: 'error', timestamp: Date.now(), usage };
  try {
    ledger.compression(message, 'compactor', 'session-9', { incidentId: 'compaction-7', recoveryIncidentId: 'recovery-77',
      attempt: 2, outcome: 'error', failed: true, errorCategory: 'policy_refusal' });
    const [entry] = new UsageLedger(dir).entries;
    assert.equal(entry.incidentId, 'compaction-7');
    assert.equal(entry.recoveryIncidentId, 'recovery-77');
    assert.equal(entry.attempt, 2);
    assert.equal(entry.errorCategory, 'policy_refusal');
    assert.equal(entry.failed, true);
  } finally { removeDir(dir); }
});

test('conversation backfill distinguishes subagent role and explicit zero-output failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-failed-turn-'));
  try {
    const usage = { ...emptyUsage(), input: 5, totalTokens: 5 };
    const main = SessionManager.inMemory();
    main.appendMessage({ role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'model-a', stopReason: 'error', errorMessage: 'SECRET FAILURE', timestamp: Date.now(), usage });
    const child = SessionManager.inMemory();
    child.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic-messages', provider: 'anthropic', model: 'model-a', stopReason: 'stop', timestamp: Date.now(), usage });
    const ledger = new UsageLedger(dir);
    ledger.backfill(main.getEntries(), main.getSessionId());
    ledger.backfill(child.getEntries(), child.getSessionId(), 'subagent', 'child-1');
    assert.deepEqual(ledger.entries.map(entry => [entry.role, entry.kind, entry.failed]), [
      ['main', 'conversation', true], ['subagent', 'subagent', undefined],
    ]);
    assert.doesNotMatch(readFileSync(join(dir, 'usage.jsonl'), 'utf8'), /SECRET FAILURE/);
    assert.equal(summarizeUsage(ledger.entries).failures, 1);
  } finally { removeDir(dir); }
});

test('Pi forks preserve usage identity instead of charging inherited messages twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-fork-usage-'));
  try {
    const manager = SessionManager.create(dir, dir), ledger = new UsageLedger(dir);
    const leaf = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Paid for once' }], api: 'anthropic-messages', provider: 'anthropic', model: 'test', stopReason: 'stop', timestamp: Date.now(), usage: { ...emptyUsage(), input: 100, totalTokens: 100 } });
    ledger.backfill(manager.getEntries(), manager.getSessionId());
    const forkFile = manager.createBranchedSession(leaf); assert.ok(forkFile);
    const fork = SessionManager.open(forkFile);
    ledger.backfill(fork.getEntries(), fork.getSessionId());
    assert.equal(ledger.entries.length, 1);
    assert.equal(summarizeUsage(ledger.entries).total.totalTokens, 100);
    assert.equal(ledger.select('This session', fork.getSessionId()).length, 0);
  } finally { removeDir(dir); }
});

test('recent ranges use local midnight and a rolling seven days without attributing legacy records to a session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-'));
  const now = new Date(2026, 9, 5, 12).getTime();
  try {
    const ledger = new UsageLedger(dir);
    for (const hours of [1, 13, 100, 200]) ledger.add({ date: new Date(now - hours * 3600_000).toISOString(), role: 'compactor', model: 'test', usage: emptyUsage() });
    assert.equal(ledger.select('Today', 'x', now).length, 1);
    assert.equal(ledger.select('Last 7 days', 'x', now).length, 3);
    assert.equal(ledger.select('This session', 'x', now).length, 0);
  } finally { removeDir(dir); }
});

test('All time keeps entries dated after now', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-'));
  const now = Date.now();
  try {
    const ledger = new UsageLedger(dir);
    ledger.add({ id: 'future', date: new Date(now + 3600_000).toISOString(), role: 'main', model: 'test', session: 's', usage: emptyUsage() });
    assert.equal(ledger.select('All time', 's', now).length, 1);
    assert.equal(ledger.select('Last hour', 's', now).length, 0);
  } finally { removeDir(dir); }
});

/** A ledger line, as another writer (or an older OptChat) would append it. */
function record(i: number, now: number, extra: Partial<UsageEntry> = {}): UsageEntry {
  const usage = { ...emptyUsage(), input: i, output: 2 * i, cacheRead: 10 * i, totalTokens: 13 * i, cost: { ...emptyUsage().cost, input: i / 1000, total: i / 300 } };
  return { id: `r${i}`, date: new Date(now - i * 600_000).toISOString(), role: i % 3 ? 'main' : 'compactor', provider: i % 2 ? 'anthropic' : undefined,
    model: `m${i % 4}`, session: i % 5 ? 's1' : 's2', usage, ...(i % 4 ? { latency: { firstMs: 100 * i, responseMs: 200 * i } } : {}), ...(i % 7 ? {} : { failed: true }), ...extra };
}
const writeLedger = (dir: string, lines: unknown[]) => writeFileSync(join(dir, 'usage.jsonl'), lines.map(l => JSON.stringify(l) + '\n').join(''));
/** The index's SQL totals must equal summing the same records in JavaScript, for every range. */
function assertSummariesMatch(ledger: UsageLedger, session: string, now: number) {
  for (const range of ranges) {
    const records = ledger.select(range, session, now), expected = summarizeUsage(records), actual = ledger.summary(range, session, now);
    assert.equal(actual.calls, records.length, range);
    assert.equal(actual.failures, expected.failures, range);
    assert.deepEqual(actual.latency, expected.latency, range);
    assert.deepEqual(actual.groups.map(g => [g.role, g.provider, g.model, g.calls, g.failures, g.usage.totalTokens, g.latency]),
      expected.groups.map(g => [g.role, g.provider, g.model, g.calls, g.failures, g.usage.totalTokens, g.latency]), range);
    assert.ok(Math.abs(actual.total.cost.total - expected.total.cost.total) < 1e-9, range);
    assert.equal(actual.total.totalTokens, expected.total.totalTokens, range);
  }
}

test('usage.db is a disposable index: it picks up other writers, rebuilds when deleted, corrupt or out of date, and matches the full read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-index-'));
  const now = Date.now(), db = join(dir, 'usage.db');
  try {
    writeLedger(dir, [...Array.from({ length: 40 }, (_, i) => record(i + 1, now)), { torn: true }, record(1, now, { model: 'duplicate id' })]);
    let ledger = new UsageLedger(dir);
    assert.ok(existsSync(db), 'opening a profile builds the index');
    const full = new UsageLedger(dir, { sqlite: false });
    assert.deepEqual(ledger.entries, full.entries, 'the index returns what the full read returns, first record per ID winning');
    assert.deepEqual(ledger.warnings, full.warnings);
    assert.equal(ledger.entries.length, 40);
    assertSummariesMatch(ledger, 's1', now);
    assertSummariesMatch(full, 's1', now);

    appendFileSync(join(dir, 'usage.jsonl'), JSON.stringify(record(41, now)) + '\n' + JSON.stringify(record(42, now)).slice(0, 20));
    assert.equal(ledger.select('All time', '', now).length, 41, 'another writer\'s complete line is indexed; its unfinished line waits');
    appendFileSync(join(dir, 'usage.jsonl'), JSON.stringify(record(42, now)).slice(20) + '\n');
    assert.equal(ledger.select('All time', '', now).length, 42, 'the line is read once it ends');
    assertSummariesMatch(ledger, 's1', now); // the late records join hours the index had already totalled

    rmSync(db);
    assert.equal(new UsageLedger(dir).entries.length, 42, 'a deleted index is rebuilt from the ledger');
    writeFileSync(db, 'not a database');
    for (const suffix of ['-wal', '-shm']) rmSync(db + suffix, { force: true });
    ledger = new UsageLedger(dir);
    assert.equal(ledger.entries.length, 42, 'a corrupt index is rebuilt from the ledger');
    assert.deepEqual(ledger.warnings, full.warnings);

    writeLedger(dir, Array.from({ length: 50 }, (_, i) => record(i + 100, now)));
    assert.deepEqual(new UsageLedger(dir).entries.map(e => e.id), Array.from({ length: 50 }, (_, i) => `r${i + 100}`), 'a replaced ledger is reindexed, not appended to the old one');
    writeLedger(dir, [record(7, now)]);
    assert.deepEqual(new UsageLedger(dir).entries.map(e => e.id), ['r7'], 'a shorter ledger is reindexed');
    rmSync(join(dir, 'usage.jsonl'));
    assert.deepEqual(new UsageLedger(dir).entries, [], 'a missing ledger empties the index');
  } finally { removeDir(dir); }
});

test('reopening reads only what the ledger gained, and adding keeps one record per ID across processes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-incremental-'));
  const now = Date.now();
  try {
    writeLedger(dir, Array.from({ length: 60 }, (_, i) => record(i + 1, now)));
    new UsageLedger(dir);
    // Rewrite the first record in place, far before the bytes the index fingerprints: an append-only ledger never does this,
    // so an index that re-read the whole file on open would show the change in its totals and this one does not.
    const file = join(dir, 'usage.jsonl'), text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace('"model":"m1"', '"model":"mX"'));
    const ledger = new UsageLedger(dir);
    const models = ledger.summary('All time', '', now).groups.map(g => g.model);
    assert.ok(models.includes('m1') && !models.includes('mX'), models.join());
    const other = new UsageLedger(dir);
    other.add(record(61, now));
    ledger.add(record(61, now));
    ledger.add(record(62, now));
    assert.equal(readFileSync(file, 'utf8').split('\n').filter(l => l.includes('"id":"r61"')).length, 1, 'an ID another process already wrote is not appended again');
    assert.equal(new UsageLedger(dir).entries.length, 62);
  } finally { removeDir(dir); }
});

test('without node:sqlite the ledger reads usage.jsonl in full and gives the same results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-memory-'));
  const now = Date.now();
  try {
    writeLedger(dir, Array.from({ length: 20 }, (_, i) => record(i + 1, now)));
    const ledger = new UsageLedger(dir, { sqlite: false });
    ledger.add(record(21, now)); ledger.add(record(21, now));
    assert.ok(!existsSync(join(dir, 'usage.db')));
    assert.equal(ledger.entries.length, 21);
    assertSummariesMatch(ledger, 's2', now);
    assert.deepEqual(new UsageLedger(dir).entries, new UsageLedger(dir, { sqlite: false }).entries);
  } finally { removeDir(dir); }
});

test('add rejects a record that a reload would reject, so totals match after a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-'));
  const now = Date.now();
  try {
    const ledger = new UsageLedger(dir);
    const good = { ...emptyUsage(), totalTokens: 7, cost: { ...emptyUsage().cost, total: 0.5 } };
    ledger.add({ id: 'good', date: new Date(now).toISOString(), role: 'main', model: 'test', usage: good });
    ledger.add({ id: 'nan', date: new Date(now).toISOString(), role: 'main', model: 'test', usage: { ...good, cost: { ...good.cost, total: NaN } } });
    ledger.add({ id: 'negative', date: new Date(now).toISOString(), role: 'main', model: 'test', usage: { ...good, input: -1 } });
    ledger.add({ id: 'date', date: 'yesterday', role: 'main', model: 'test', usage: good });
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.warnings.length, 1);
    const live = summarizeUsage(ledger.select('All time', '', now)).total;
    const reloaded = new UsageLedger(dir);
    assert.deepEqual(summarizeUsage(reloaded.select('All time', '', now)).total, live);
    assert.deepEqual(reloaded.warnings, []);
    assert.equal(live.cost.total, 0.5);
  } finally { removeDir(dir); }
});
