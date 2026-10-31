import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { parseOutcomeInput, parseSignal } from '../src/contracts/signals.ts';
import { decideReflex, ATTENTION_COOLDOWN_MS } from '../src/journal/rules.ts';
import { SignalStore } from '../src/journal/store.ts';
import { SignalService } from '../src/journal/service.ts';
import { SpoolPoller } from '../src/journal/spool.ts';
import { createNotificationCenter } from '../src/notifications/center.ts';
import { createAssistantServer } from '../src/http/server.ts';
import { TaskStore } from '../src/store/db.ts';

const PROFILE = 'profile-a';
const BASE = Date.parse('2026-10-26T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

type SignalInput = Parameters<typeof parseSignal>[0] & Record<string, unknown>;
function signal(overrides: Record<string, unknown> = {}) {
  const observedAt = overrides.observedAt ?? iso(BASE);
  return {
    version: 1, signalId: `signal-${Math.random().toString(16).slice(2)}`, profileId: PROFILE,
    source: 'ci', kind: 'ci.failed', severity: 'warning', observedAt,
    dedupeKey: `dedupe-${Math.random().toString(16).slice(2)}`, subject: 'owner/repo#1',
    summary: 'CI failed on the pull request head', correlationId: null, attention: 'notify',
    evidence: { kind: 'observed', reference: 'gh:run/1' }, ...overrides,
  };
}
function outcome(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, outcomeId: `outcome-${Math.random().toString(16).slice(2)}`, profileId: PROFILE,
    capability: 'deploy', expectation: 'merged and deployed', result: 'published', verification: 'verified',
    evidence: 'gh:release/1', costUsd: 0.01, latencyMs: 1000, modelCalls: 1, taskId: null, signalId: null,
    observedAt: '2026-10-27T10:00:00.000Z', ...overrides,
  };
}
async function withStore(run: (store: SignalStore, service: SignalService, clock: (value: number) => void) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  const store = new SignalStore(join(dir, 'journal.sqlite'), PROFILE);
  let now = BASE;
  const service = new SignalService({ store, clock: () => now });
  const clock = (value: number) => { now = value; };
  try { await run(store, service, clock); }
  finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('signal and outcome contracts reject unknown shapes instead of coercing them', () => {
  const valid = signal();
  assert.deepEqual(parseSignal(valid), valid);
  for (const change of [
    { version: 2 }, { kind: 'ci.exploded' }, { source: 'browser' }, { severity: 'fatal' }, { attention: 'dispatch' },
    { observedAt: '2026-10-26T12:00:00+00:00' }, { dedupeKey: ' ' }, { summary: 'x'.repeat(501) },
    { correlationId: 'x'.repeat(201) }, { evidence: { kind: 'inferred', reference: 'x' } },
    { evidence: { kind: 'observed', reference: 'x', confidence: 1 } }, { extra: true },
  ]) assert.throws(() => parseSignal({ ...valid, ...change }), TypeError, JSON.stringify(change));

  const validOutcome = outcome();
  assert.deepEqual(parseOutcomeInput(validOutcome), validOutcome);
  for (const change of [
    { capability: 'Deploy' }, { capability: '' }, { verification: 'done' }, { evidence: '' }, { costUsd: -0.01 },
    { costUsd: 1_000_001 }, { latencyMs: -1 }, { latencyMs: 1.5 }, { modelCalls: -1 },
    { observedAt: 'yesterday' }, { taskId: 7 }, { extra: true },
  ]) assert.throws(() => parseOutcomeInput({ ...validOutcome, ...change }), TypeError, JSON.stringify(change));
});

test('fixed rules notify, resolve with an open issue and honour the cooldown', () => {
  const context = { openIssue: false, lastAttentionAt: null, now: BASE };
  assert.deepEqual(decideReflex({ kind: 'ci.failed', severity: 'warning' }, context), {
    ruleId: 'attention.ci.failed', action: 'notify', reason: 'signal needs operator attention',
    category: 'signal_attention', cooldownMs: ATTENTION_COOLDOWN_MS,
  });
  assert.equal(decideReflex({ kind: 'pc.disk_low', severity: 'critical' }, context).reason, 'critical signal needs operator attention');
  assert.equal(decideReflex({ kind: 'health.recovered', severity: 'info' }, { ...context, openIssue: true }).action, 'resolve');
  assert.equal(decideReflex({ kind: 'health.recovered', severity: 'info' }, context).action, 'ignore');
  assert.equal(decideReflex({ kind: 'ci.failed', severity: 'warning' }, { ...context, lastAttentionAt: BASE - 1 }).action, 'ignore');
  assert.equal(decideReflex({ kind: 'ci.failed', severity: 'warning' }, { ...context, lastAttentionAt: BASE - ATTENTION_COOLDOWN_MS }).action, 'notify');
  assert.equal(decideReflex({ kind: 'service.started', severity: 'info' }, context).action, 'ignore');
});

test('signals are stored once by dedupe key and a replay completes a missing decision', async () => {
  await withStore((store, service) => {
    const first = service.ingest(signal());
    assert.equal(first.duplicate, false);
    assert.equal(first.decision?.action, 'notify');
    assert.equal(first.notifications, 0);
    assert.notEqual(store.openIssue('owner/repo#1'), null);

    const replay = service.ingest(signal({ signalId: first.signal.signalId, dedupeKey: first.signal.dedupeKey }));
    assert.equal(replay.duplicate, true);
    assert.equal(replay.signal.sequence, first.signal.sequence);
    assert.equal(replay.decision?.ruleId, 'attention.ci.failed');

    // Same signalId with a different external event is a producer bug, not a second observation.
    assert.throws(() => service.ingest(signal({ signalId: first.signal.signalId })), TypeError);
    assert.equal(store.signals().signals.length, 1);
    assert.equal(service.metrics().duplicates, 1);
  });
});

test('a signal stored without a decision is decided on its duplicate replay', async () => {
  await withStore((store, service) => {
    const input = signal({ attention: 'wake' });
    const stored = store.ingest(input);
    assert.equal(store.decision(stored.signal.sequence), null);
    const replay = service.ingest(input);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.decision?.action, 'notify');
    assert.notEqual(store.decision(stored.signal.sequence), null);
    assert.equal(service.metrics().turnsAvoided, 1);
  });
});

test('metrics count sources, outcomes of the rules, latency and only real wake substitutions', async () => {
  await withStore((store, service, clock) => {
    const ingest = (value: Record<string, unknown>, at: number) => { clock(at); service.ingest(signal(value)); };
    ingest({ signalId: 's1', dedupeKey: 'd1', observedAt: iso(BASE - 5000), attention: 'wake' }, BASE);
    ingest({ signalId: 's2', source: 'shell', kind: 'shell.failed', subject: 'job-1', dedupeKey: 'd2', attention: 'wake' }, BASE + 1000);
    ingest({ signalId: 's3', source: 'health', kind: 'health.down', subject: 'site', dedupeKey: 'd3' }, BASE + 2000);
    ingest({ signalId: 's4', source: 'health', kind: 'health.recovered', subject: 'site', dedupeKey: 'd4', severity: 'info' }, BASE + 3000);
    ingest({ signalId: 's5', source: 'pc', kind: 'pc.disk_low', subject: 'C:', dedupeKey: 'd5', attention: 'wake' }, BASE + 3500);
    ingest({ signalId: 's6', dedupeKey: 'd6', subject: 'owner/repo#1', attention: 'wake' }, BASE + 4000);
    ingest({ signalId: 's7', source: 'quota', kind: 'quota.near', subject: 'codex', dedupeKey: 'd7' }, BASE + 5000);
    service.ingest(signal({ signalId: 's1', dedupeKey: 'd1' }));

    const metrics = service.metrics(0, Number.MAX_SAFE_INTEGER);
    assert.equal(metrics.total, 7);
    assert.deepEqual(metrics.bySource, { ci: 2, health: 2, pc: 1, quota: 1, shell: 1 });
    assert.deepEqual(metrics.byKind, {
      'ci.failed': 2, 'health.down': 1, 'health.recovered': 1, 'pc.disk_low': 1, 'quota.near': 1, 'shell.failed': 1,
    });
    assert.deepEqual([metrics.notify, metrics.resolve, metrics.ignore], [5, 1, 1]);
    assert.equal(metrics.handledWithoutModel, 6);
    assert.equal(metrics.turnsAvoided, 4);
    assert.equal(metrics.resolutionRate, 0.166667);
    assert.equal(metrics.p50DecisionMs, 3500);
    assert.equal(metrics.p95DecisionMs, 5000);
    assert.equal(metrics.modelCalls, 0);
    assert.equal(metrics.duplicates, 1);

    assert.equal(store.openIssue('site'), null, 'the recovery closed the health issue');
    assert.notEqual(store.openIssue('owner/repo#1'), null, 'the cooldown did not reopen or close the issue');
  });
});

test('outcomes are idempotent, summarize cost and turn repeated unverified work into proposals', async () => {
  await withStore((store, service) => {
    assert.throws(() => store.recordOutcome(outcome({ profileId: 'other' })), TypeError);
    const first = service.recordOutcome(outcome({ outcomeId: 'o1', verification: 'not_verified', evidence: 'tests:missing', costUsd: 0.02, latencyMs: 1000, modelCalls: 3 }));
    assert.equal(first.verification, 'not_verified');
    assert.equal(service.recordOutcome(outcome({ outcomeId: 'o1', verification: 'verified' })).sequence, first.sequence, 'same id returns the stored outcome');
    service.recordOutcome(outcome({ outcomeId: 'o2', verification: 'blocked', evidence: 'gh:timeout', costUsd: 0.01, latencyMs: 2000, modelCalls: 2 }));
    service.recordOutcome(outcome({ outcomeId: 'o3', capability: 'search', verification: 'verified', evidence: 'http:200', costUsd: 0.005, latencyMs: 500, modelCalls: 1 }));
    service.recordOutcome(outcome({ outcomeId: 'o4', verification: 'uncertain', evidence: 'run:7', costUsd: 0, latencyMs: 3000, modelCalls: 1 }));

    const page = service.outcomes();
    assert.equal(page.outcomes.length, 4);
    assert.equal(page.nextCursor, null);
    assert.equal(page.outcomes[0].verification, 'not_verified', 'the stored o1 is not upgraded by the replay');

    const review = service.review(Date.parse('2026-10-28T12:00:00.000Z'));
    assert.equal(review.weekStart, '2026-10-26');
    assert.equal(review.weekEnd, '2026-11-02');
    assert.deepEqual(review.outcomes, { total: 4, verified: 1, notVerified: 1, blocked: 1, uncertain: 1, costUsd: 0.035, latencyMs: 6500, modelCalls: 7 });
    assert.deepEqual(review.capabilities.map(c => [c.capability, c.total, c.medianLatencyMs]), [['deploy', 3, 2000], ['search', 1, 500]]);
    assert.equal(review.proposals.length, 1);
    assert.equal(review.proposals[0].capability, 'deploy');
    assert.equal(review.proposals[0].priority, 'high');
    assert.match(review.proposals[0].rule, /3 de 3 resultados/);
    assert.equal(service.latestReview()?.reviewId, review.reviewId);

    const digest = service.digest('2026-10-27');
    assert.equal(digest.profileId, PROFILE);
    assert.equal(digest.signals.total, 0);
    assert.equal(digest.outcomes.total, 4);
    assert.deepEqual(digest.review, { weekStart: '2026-10-26', proposals: 1 });
    assert.equal(JSON.stringify(digest).includes('published'), false, 'the digest carries counts, not outcome bodies');
    assert.throws(() => service.digest('2026-02-30'), TypeError);
  });
});

test('spool rotation consumes invalid lines, replays leftovers and puts unread lines back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spool-'));
  const path = join(dir, 'inbox.jsonl');
  const store = new SignalStore(join(dir, 'journal.sqlite'), PROFILE);
  const service = new SignalService({ store });
  const poller = new SpoolPoller({ path, service });
  try {
    const valid = signal({ signalId: 'spool-1', dedupeKey: 'spool-d1' });
    writeFileSync(path, `${JSON.stringify(valid)}\nnot-json\n${JSON.stringify({ ...valid, signalId: 'spool-2', dedupeKey: 'spool-d2' })}\n`);
    assert.deepEqual(poller.poll(), { ingested: 2, duplicates: 0, invalid: 1 });
    assert.equal(store.signals().signals.length, 2);

    writeFileSync(path, `${JSON.stringify(valid)}\n`);
    assert.deepEqual(poller.poll(), { ingested: 0, duplicates: 1, invalid: 0 });

    // A crash after the rotation leaves a `.processing` file; the next pass replays it instead of losing it.
    const leftover = `${path}.00000000-0000-4000-8000-000000000000.processing`;
    writeFileSync(leftover, `${JSON.stringify({ ...valid, signalId: 'spool-3', dedupeKey: 'spool-d3' })}\n`);
    assert.deepEqual(poller.poll(), { ingested: 1, duplicates: 0, invalid: 0 });
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.processing')), []);

    // Storage failure requeues the unread line and removes the rotation instead of dropping it.
    const failing = new SpoolPoller({ path, service: { ingest: () => { throw new Error('storage offline'); } } });
    writeFileSync(path, `${JSON.stringify({ ...valid, signalId: 'spool-4', dedupeKey: 'spool-d4' })}\n`);
    assert.throws(() => failing.poll(), /storage offline/);
    assert.match(readFileSync(path, 'utf8'), /spool-d4/);
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.processing')), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the notification center carries the fixed signal text, never the summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-notice-'));
  const store = new SignalStore(join(dir, 'journal.sqlite'), PROFILE);
  const authority = {};
  const center = createNotificationCenter({ databasePath: join(dir, 'notifications.sqlite'), operatorAuthority: authority });
  center.setConsent('local', true, authority);
  try {
    const service = new SignalService({
      store, channels: ['local'], clock: () => BASE,
      notify: input => center.notify({ id: input.id, channel: input.channel, category: input.category, ref: input.ref }),
    });
    const attention = signal({ signalId: 'notice-1', dedupeKey: 'notice-d1', summary: 'SECRET-REPO-DETAIL' });
    service.ingest(attention);
    service.ingest(signal({ signalId: 'notice-2', dedupeKey: 'notice-d2', severity: 'info', kind: 'health.recovered', subject: 'owner/repo#1' }));

    const delivered: { id: string; text: string; ref: string }[] = [];
    assert.deepEqual(await center.deliver('local', note => { delivered.push(note); }), { accepted: 2, deferred: 0, suppressed: 0, failed: 0 });
    assert.deepEqual(delivered.map(note => note.text), ['A monitored signal needs your attention.', 'A monitored signal recovered.']);
    assert.deepEqual(delivered.map(note => note.ref), [attention.signalId, 'notice-2']);
    assert.equal(JSON.stringify(delivered).includes('SECRET-REPO-DETAIL'), false);
  } finally {
    center.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authenticated journal routes validate input and stay absent without the opt-in', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-http-'));
  const token = 'journal-secret';
  const taskStore = new TaskStore(join(dir, 'tasks.sqlite'), PROFILE);
  const store = new SignalStore(join(dir, 'journal.sqlite'), PROFILE);
  const service = new SignalService({ store, clock: () => BASE });
  const server = createAssistantServer({ store: taskStore, token, profileId: PROFILE, journal: service });
  const off = createAssistantServer({ store: taskStore, token, profileId: PROFILE });
  const listen = async (srv: ReturnType<typeof createAssistantServer>) => { srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); return `http://127.0.0.1:${(srv.address() as any).port}`; };
  const base = await listen(server), disabled = await listen(off);
  const request = async (route: string, options: RequestInit = {}, root = base) => {
    const response = await fetch(root + route, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
    return { status: response.status, body: await response.text() };
  };
  const post = (route: string, body: unknown) => request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await t.test('the disabled service does not expose the journal', async () => {
      assert.equal((await request('/v1/signals', {}, disabled)).status, 404);
      assert.equal((await request('/v1/signals/metrics', {}, disabled)).status, 404);
      assert.equal((await request('/v1/journal/digest', {}, disabled)).status, 404);
    });
    await t.test('signals validate at the boundary and page', async () => {
      assert.equal((await post('/v1/signals', signal({ kind: 'ci.exploded' }))).status, 400);
      assert.equal((await post('/v1/signals', signal({ profileId: 'other' }))).status, 400);
      assert.equal((await request('/v1/signals', { method: 'POST', body: '{}' })).status, 400);
      assert.equal((await request('/v1/signals')).status, 200);
      const created = await post('/v1/signals', signal({ signalId: 'http-1', dedupeKey: 'http-d1', subject: 'owner/repo#9' }));
      assert.equal(created.status, 200);
      const body = JSON.parse(created.body);
      assert.equal(body.duplicate, false);
      assert.equal(body.decision.action, 'notify');
      assert.equal((await post('/v1/signals', signal({ signalId: 'http-1', dedupeKey: 'http-d1' }))).status, 200);
      assert.equal((await post('/v1/signals', signal({ signalId: 'http-2', dedupeKey: 'http-d2', subject: 'owner/repo#10' }))).status, 200);
      const page = JSON.parse((await request('/v1/signals?limit=1')).body);
      assert.equal(page.signals.length, 1);
      assert.equal(page.nextCursor, 1);
      assert.equal((await request('/v1/signals?limit=0')).status, 400);
      assert.equal((await request('/v1/signals?unknown=1')).status, 400);
      assert.equal((await request('/v1/signals/metrics')).status, 200);
      assert.equal(JSON.parse((await request('/v1/signals/metrics')).body).total, 2);
    });
    await t.test('outcomes and the weekly review validate and page', async () => {
      assert.equal((await post('/v1/outcomes', outcome({ capability: 'Deploy' }))).status, 400);
      const created = await post('/v1/outcomes', outcome({ outcomeId: 'http-o1' }));
      assert.equal(created.status, 200);
      assert.equal(JSON.parse(created.body).outcomeId, 'http-o1');
      assert.equal((await request('/v1/outcomes')).status, 200);
      assert.equal(JSON.parse((await request('/v1/outcomes')).body).outcomes.length, 1);
      assert.equal((await request('/v1/review')).status, 404);
      assert.equal((await post('/v1/review', {})).status, 200);
      assert.equal(JSON.parse((await request('/v1/review')).body).reviewId, 'review-2026-10-26');
      assert.equal((await post('/v1/review', { extra: true })).status, 400);
      assert.equal((await request('/v1/journal/digest?day=2026-10-27')).status, 200);
      assert.equal((await request('/v1/journal/digest?day=2026-2-3')).status, 400);
      assert.equal((await request('/v1/journal/digest?day=2026-02-30')).status, 400);
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => off.close(() => resolve()));
    store.close();
    taskStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
