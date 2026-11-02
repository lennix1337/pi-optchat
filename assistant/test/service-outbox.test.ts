import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Outbox, OutboxRefused } from '../src/outbox/outbox.ts';
import { immediate } from '../src/store/transaction.ts';
import { SlackPoster, SlackRelay } from '../src/channels/slack-relay.ts';
import { SlackChannel } from '../src/channels/slack.ts';
import { channelFixture, PROFILE, slackEnvelope } from './channel-support.ts';

const TEAM = 'T0TEST'; const APP = 'A0TEST';
const CHANNELS = { harness: 'C0HARNESS' };

function withTempDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assistant-outbox-'));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

/** A clock the test moves by hand, so due times are exact. */
function clock(start = 1_793_000_000_000) {
  let t = start;
  return { now: () => t, advance(ms: number) { t += ms; } };
}

/** Fake Slack: `respond` decides each call; the request body is parsed like the real API would receive it. */
function fakeSlack(respond: (call: number, body: Record<string, unknown>) => Promise<Response> | Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return respond(calls.length, JSON.parse(String(init.body)) as Record<string, unknown>);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}
const posted = (ts = '1793000000.000200') => new Response(JSON.stringify({ ok: true, ts, channel: 'D0OWNER' }), { status: 200 });
const refused = (error: string) => new Response(JSON.stringify({ ok: false, error }), { status: 200 });

/** Polls until the condition holds; the dispatcher runs on timers and promises, never on a fixed sleep. */
async function until(condition: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function openDb(dir: string) { return new DatabaseSync(join(dir, 'outbox.sqlite')); }

// ---- The transactional outbox itself ------------------------------------------------------------

test('an effect can only be staged inside the transaction of the state change that causes it', withTempDir(async dir => {
  const db = openDb(dir);
  try {
    const outbox = new Outbox(db, PROFILE, { now: clock().now });
    assert.throws(() => outbox.stage({ id: 'loose', channel: 'slack', kind: 'post', payload: {} }), /outbox_requires_transaction/);
    assert.equal(outbox.get('loose'), null);
  } finally { db.close(); }
}));

test('a rolled-back state change leaves no effect row behind, and a committed one always has its row', withTempDir(async dir => {
  const db = openDb(dir);
  try {
    const outbox = new Outbox(db, PROFILE, { now: clock().now });
    assert.throws(() => immediate(db, () => { outbox.stage({ id: 'undone', channel: 'slack', kind: 'post', payload: { text: 'x' } }); throw new Error('state change failed'); }), /state change failed/);
    assert.equal(outbox.get('undone'), null, 'the effect is rolled back with the change');
    immediate(db, () => outbox.stage({ id: 'kept', channel: 'slack', kind: 'post', payload: { text: 'y' } }));
    assert.equal(outbox.get('kept')?.state, 'pending');
  } finally { db.close(); }
}));

test('the same idempotency key with the same content is a no-op; with other content it is refused and changes nothing', withTempDir(async dir => {
  const db = openDb(dir);
  try {
    const outbox = new Outbox(db, PROFILE, { now: clock().now });
    const entry = { id: 'receipt:D1', channel: 'slack', kind: 'receipt', payload: { text: 'Recebi' } };
    assert.equal(immediate(db, () => outbox.stage(entry)), 'staged');
    assert.equal(immediate(db, () => outbox.stage({ ...entry })), 'duplicate');
    assert.throws(() => immediate(db, () => outbox.stage({ ...entry, payload: { text: 'outra coisa' } })), /outbox_conflict/);
    assert.equal(outbox.list('pending').length, 1);
    assert.deepEqual(outbox.get('receipt:D1')?.payload, { text: 'Recebi' });
  } finally { db.close(); }
}));

test('crash between the state change and the send: the committed effect survives the restart and is sent once', withTempDir(async dir => {
  const now = clock();
  const first = openDb(dir);
  immediate(first, () => new Outbox(first, PROFILE, { now: now.now }).stage({ id: 'receipt:1', channel: 'slack', kind: 'receipt', payload: { text: 'ok' } }));
  first.close(); // the process dies before any dispatch

  const db = openDb(dir);
  try {
    const outbox = new Outbox(db, PROFILE, { now: now.now });
    assert.equal(outbox.recover(), 0, 'nothing was in flight: the row was never claimed');
    const sent: string[] = [];
    assert.deepEqual(await outbox.dispatch(async row => { sent.push(row.id); }), { sent: 1, failed: 0, retrying: 0, uncertain: 0 });
    assert.deepEqual(await outbox.dispatch(async row => { sent.push(row.id); }), { sent: 0, failed: 0, retrying: 0, uncertain: 0 });
    assert.deepEqual(sent, ['receipt:1']);
    assert.equal(outbox.get('receipt:1')?.state, 'sent');
  } finally { db.close(); }
}));

test('duplicate delivery: a crash after the provider accepted the send, before it is recorded, never sends again', withTempDir(async dir => {
  const now = clock();
  const first = openDb(dir);
  immediate(first, () => new Outbox(first, PROFILE, { now: now.now }).stage({ id: 'post:1', channel: 'slack', kind: 'post', payload: { text: 'resposta' } }));
  const delivered: string[] = [];
  const dying = new Outbox(first, PROFILE, { now: now.now, boundary: (name, id) => { if (name === 'transport_returned') { first.close(); throw new Error('process died'); } } });
  await assert.rejects(dying.dispatch(async row => { delivered.push(row.id); }), /process died/);
  assert.deepEqual(delivered, ['post:1'], 'the provider got one call');

  const db = openDb(dir);
  try {
    const outbox = new Outbox(db, PROFILE, { now: now.now });
    assert.equal(outbox.recover(), 1, 'the row left in flight becomes uncertain');
    assert.equal(outbox.get('post:1')?.state, 'uncertain');
    assert.equal(outbox.get('post:1')?.reason, 'interrupted');
    await outbox.dispatch(async row => { delivered.push(row.id); });
    assert.deepEqual(delivered, ['post:1'], 'the uncertain row is not resent by the dispatcher');
    outbox.reconcile('post:1', 'sent');
    assert.equal(outbox.get('post:1')?.state, 'sent');
  } finally { db.close(); }
}));

test('a transport failure that is not a refusal is uncertain: never resent, reconciled by an operator', withTempDir(async dir => {
  const now = clock();
  const db = openDb(dir);
  try {
    const outbox = new Outbox(db, PROFILE, { now: now.now, retryDelayMs: 1000 });
    immediate(db, () => outbox.stage({ id: 'post:2', channel: 'slack', kind: 'post', payload: { text: 'a' } }));
    let calls = 0;
    assert.deepEqual(await outbox.dispatch(async () => { calls++; throw new Error('socket hang up'); }), { sent: 0, failed: 0, retrying: 0, uncertain: 1 });
    now.advance(60_000);
    await outbox.dispatch(async () => { calls++; });
    assert.equal(calls, 1, 'an ambiguous send is not repeated');
    assert.equal(outbox.get('post:2')?.reason, 'transport_error');
    outbox.reconcile('post:2', 'not_sent');
    await outbox.dispatch(async () => { calls++; });
    assert.equal(calls, 2, 'after the operator confirms nothing was posted, the same id is sent again');
    assert.equal(outbox.get('post:2')?.state, 'sent');
    assert.throws(() => outbox.reconcile('post:2', 'not_sent'), /outbox_not_uncertain/, 'only an uncertain row can be reconciled');
  } finally { db.close(); }
}));

test('a retryable refusal is retried with backoff until it succeeds; a definite one fails at once; the budget is finite', withTempDir(async dir => {
  const now = clock();
  const db = openDb(dir);
  try {
    const outbox = new Outbox(db, PROFILE, { now: now.now, retryDelayMs: 1000, maxAttempts: 3 });
    immediate(db, () => outbox.stage({ id: 'retry:1', channel: 'slack', kind: 'receipt', payload: { text: 'a' } }));
    immediate(db, () => outbox.stage({ id: 'auth:1', channel: 'slack', kind: 'receipt', payload: { text: 'b' } }));
    const script: Record<string, (() => void)[]> = { 'retry:1': [() => { throw new OutboxRefused('slack_ratelimited', true); }, () => { throw new OutboxRefused('slack_ratelimited', true); }] };
    const seen: string[] = [];
    const transport = async (row: { id: string }) => {
      seen.push(row.id);
      const step = script[row.id]?.shift();
      if (row.id === 'auth:1') throw new OutboxRefused('slack_invalid_auth', false);
      if (step) step();
    };
    assert.deepEqual(await outbox.dispatch(transport), { sent: 0, failed: 1, retrying: 1, uncertain: 0 });
    assert.equal(outbox.get('retry:1')?.state, 'pending');
    assert.equal(outbox.get('retry:1')?.reason, 'slack_ratelimited');
    assert.equal(outbox.get('auth:1')?.state, 'failed');
    assert.equal(outbox.get('auth:1')?.reason, 'slack_invalid_auth');
    assert.equal(outbox.nextDueAt(), now.now() + 1000, 'the retry waits its backoff');
    assert.deepEqual(await outbox.dispatch(transport), { sent: 0, failed: 0, retrying: 0, uncertain: 0 }, 'not due before the backoff');
    now.advance(1000);
    assert.deepEqual(await outbox.dispatch(transport), { sent: 0, failed: 0, retrying: 1, uncertain: 0 }, 'second refusal, still within budget');
    now.advance(2000);
    assert.deepEqual(await outbox.dispatch(transport), { sent: 1, failed: 0, retrying: 0, uncertain: 0 });
    assert.equal(outbox.get('retry:1')?.state, 'sent');
    assert.equal(outbox.get('retry:1')?.attempts, 3);
    assert.deepEqual(seen, ['retry:1', 'auth:1', 'retry:1', 'retry:1']);
  } finally { db.close(); }
}));

test('a retryable refusal that exhausts the budget ends failed, with the budget named in the reason', withTempDir(async dir => {
  const now = clock();
  const db = openDb(dir);
  try {
    const outbox = new Outbox(db, PROFILE, { now: now.now, retryDelayMs: 1, maxAttempts: 2 });
    immediate(db, () => outbox.stage({ id: 'busy:1', channel: 'slack', kind: 'receipt', payload: {} }));
    const busy = async () => { throw new OutboxRefused('slack_ratelimited', true); };
    await outbox.dispatch(busy); now.advance(10);
    assert.deepEqual(await outbox.dispatch(busy), { sent: 0, failed: 1, retrying: 0, uncertain: 0 });
    assert.equal(outbox.get('busy:1')?.state, 'failed');
    assert.equal(outbox.get('busy:1')?.reason, 'slack_ratelimited:attempts_exhausted');
  } finally { db.close(); }
}));

test('a synchronous write records its intent before the call; a refusal is terminal, a lost answer is uncertain', withTempDir(async dir => {
  const now = clock();
  const db = openDb(dir);
  try {
    const outbox = new Outbox(db, PROFILE, { now: now.now });
    let during: string | undefined;
    await assert.rejects(outbox.perform('slack', 'post', { text: 'x' }, async () => {
      during = outbox.list('sending')[0]?.id;
      throw new OutboxRefused('slack_channel_not_found');
    }), /slack_channel_not_found/);
    assert.match(during ?? '', /^post:/, 'the intent was committed while the call was in flight');
    assert.equal(outbox.get(during!)?.state, 'failed', 'a refusal is final for the caller');
    assert.equal(await outbox.perform('slack', 'post', {}, async () => 'ok'), 'ok');
    await assert.rejects(outbox.perform('slack', 'post', {}, async () => { throw new Error('ECONNRESET'); }), /ECONNRESET/);
    assert.deepEqual(outbox.list('uncertain').map(r => r.reason), ['transport_error']);
    assert.equal(outbox.list('sent').length, 1);
    assert.equal(outbox.list('pending').length, 0, 'a synchronous write is never queued for the dispatcher');
  } finally { db.close(); }
}));

test('reconcile and recover only touch the rows they name', withTempDir(async dir => {
  const now = clock();
  const db = openDb(dir);
  try {
    const outbox = new Outbox(db, PROFILE, { now: now.now });
    immediate(db, () => outbox.stage({ id: 'done:1', channel: 'slack', kind: 'receipt', payload: {} }));
    await outbox.dispatch(async () => undefined);
    assert.equal(outbox.recover(), 0);
    assert.equal(outbox.get('done:1')?.state, 'sent', 'sent rows are never reopened by a restart');
    assert.throws(() => outbox.reconcile('missing:1', 'sent'), /outbox_not_uncertain/);
  } finally { db.close(); }
}));

// ---- The Slack relay and the loopback writes that use the outbox -----------------------------

function relayFixture(dir: string, now: () => number, outbox?: ConstructorParameters<typeof SlackRelay>[0]['outbox']) {
  const f = channelFixture();
  f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
  const relay = new SlackRelay({ databasePath: join(dir, 'relay.sqlite'), profileId: PROFILE, now, ...(outbox ? { outbox } : {}) });
  const channel = new SlackChannel({ store: f.store, ledger: f.ledger, profileId: PROFILE, team: TEAM, appId: APP, relay, relayChannels: new Set(Object.values(CHANNELS)), reviewLink: id => id });
  return { f, relay, channel, close() { relay.close(); f.close(); } };
}

test('a message queued while nobody reads is answered with a receipt that survives a crash before its send', withTempDir(async dir => {
  const now = clock();
  const first = relayFixture(dir, now.now);
  first.relay.attach(new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: fakeSlack(() => posted()).fetch }));
  now.advance(10 * 60_000); // no reader for ten minutes: a message now gets a receipt
  assert.equal(first.channel.accept(slackEnvelope('EvCrash1', 'oi?')).outcome, 'relayed');
  first.relay.close(); first.f.close(); // crash: the message and its receipt committed, nothing was sent

  const second = relayFixture(dir, now.now);
  try {
    const slack = fakeSlack(() => posted());
    second.relay.attach(new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: slack.fetch }));
    await second.relay.idle();
    assert.equal(slack.calls.length, 1, 'the receipt was not lost');
    assert.equal(slack.calls[0]!.body.text, 'Recebi. O OptChat não está aberto agora; sua mensagem ficou na fila e eu respondo assim que ele voltar.');
    second.relay.attach(new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: slack.fetch }));
    await second.relay.idle();
    assert.equal(slack.calls.length, 1, 'a restart does not send it again');
  } finally { second.close(); }
}));

test('an approval click retires its buttons in the same commit; a crash before the update sends it once; a repeated click adds nothing', withTempDir(async dir => {
  const now = clock();
  const r = relayFixture(dir, now.now);
  const slack = fakeSlack(() => posted());
  r.relay.attach(new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', channels: CHANNELS, fetch: slack.fetch }));
  const click = { type: 'block_actions', team: { id: TEAM }, api_app_id: APP, user: { id: 'U0OWNER' }, channel: { id: 'D0OWNER' }, container: { message_ts: '1793000000.000300', channel_id: 'D0OWNER' }, message: { text: 'Aprovar a PR?' }, actions: [{ action_id: 'optchat_approve', action_ts: '1793000001.000001' }] };
  assert.equal(r.channel.accept(click).outcome, 'relayed');
  assert.equal(r.channel.accept(click).outcome, 'duplicate');
  r.relay.close(); r.f.close(); // crash before the dispatcher ran

  const again = relayFixture(dir, now.now);
  try {
    again.relay.attach(new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', channels: CHANNELS, fetch: slack.fetch }));
    await again.relay.idle();
    const updates = slack.calls.filter(c => c.body.blocks !== undefined && Array.isArray(c.body.blocks) && c.body.blocks.length === 0);
    assert.equal(updates.length, 1, 'the retirement is sent once, after the restart');
    assert.match(String(slack.calls.find(c => c.body.blocks !== undefined && (c.body.blocks as unknown[]).length === 0)?.body.text), /Você tocou em \*Aprovar\*/);
  } finally { again.close(); }
}));

test('a Slack write through the loopback API is recorded before the call and cannot be sent again by a restart', withTempDir(async dir => {
  const now = clock();
  const first = relayFixture(dir, now.now);
  const poster = new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: (async () => { await new Promise(() => undefined); return posted(); }) as typeof fetch });
  // The call never returns: the process dies while the write is in flight.
  void first.relay.record('send', { destination: 'dm', text: 'resposta' }, () => poster.send('resposta'));
  await until(() => first.relay.outbox.list('sending').length === 1, 'intent recorded');
  first.relay.close(); first.f.close();

  const second = relayFixture(dir, now.now);
  try {
    const slack = fakeSlack(() => posted());
    second.relay.attach(new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: slack.fetch }));
    await second.relay.idle();
    assert.equal(slack.calls.length, 0, 'an in-flight write is not replayed');
    assert.deepEqual(second.relay.outbox.list('uncertain').map(r => [r.kind, r.reason]), [['send', 'interrupted']]);
  } finally { second.close(); }
}));

test('a write refused by Slack is recorded as failed; a later part that fails leaves the send uncertain, not retried', withTempDir(async dir => {
  const now = clock();
  const r = relayFixture(dir, now.now);
  try {
    const refuse = fakeSlack(() => refused('channel_not_found'));
    const poster = new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: refuse.fetch });
    await assert.rejects(r.relay.record('send', { text: 'x' }, () => poster.send('x')), /slack_channel_not_found/);
    assert.equal(r.relay.outbox.list('failed')[0]?.reason, 'slack_channel_not_found');

    const partial = fakeSlack(call => call === 1 ? posted() : refused('ratelimited'));
    const long = new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: partial.fetch });
    await assert.rejects(r.relay.record('send', { text: 'long' }, () => long.send('a'.repeat(5000))), /slack_partial_post/);
    assert.equal(partial.calls.length, 2, 'the second part was attempted once, and nothing was retried');
    assert.deepEqual(r.relay.outbox.list('uncertain').map(x => x.reason), ['transport_error'], 'the reason is a code, the caller sees slack_partial_post');
  } finally { r.close(); }
}));
