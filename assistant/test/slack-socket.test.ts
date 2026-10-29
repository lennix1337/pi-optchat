import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SlackChannel } from '../src/channels/slack.ts';
import { SlackSocket, type SocketLike } from '../src/channels/slack-socket.ts';
import { channelFixture, PROFILE } from './channel-support.ts';

const TEAM = 'T0TEST'; const APP = 'A0TEST'; const TOKEN = 'xapp-1-disposable';
const event = (eventId: string, over: Record<string, unknown> = {}) => ({
  type: 'event_callback', team_id: TEAM, api_app_id: APP, event_id: eventId,
  event: { type: 'message', channel: 'D0OWNER', user: 'U0OWNER', text: 'Pagar o boleto da luz', ts: '1793000000.000100' }, ...over,
});

class FakeSocket implements SocketLike {
  sent: string[] = []; closed = false;
  private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string) { this.sent.push(data); }
  close() { if (this.closed) return; this.closed = true; for (const l of this.listeners.get('close') ?? []) l({}); }
  deliver(message: unknown) { for (const l of this.listeners.get('message') ?? []) l({ data: JSON.stringify(message) }); }
}

function harness(accept: (payload: unknown) => ReturnType<SlackChannel['accept']>, answers: unknown[] = []) {
  const sockets: FakeSocket[] = []; const opened: string[] = []; const logs: string[] = []; const auth: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    opened.push(url); auth.push(String((init.headers as Record<string, string>).authorization));
    const body = answers.length ? answers.shift() : { ok: true, url: `wss://wss.example/link-${opened.length}` };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  const socket = new SlackSocket({ appToken: TOKEN, accept, log: line => logs.push(line), fetch, connect: () => { const s = new FakeSocket(); sockets.push(s); return s; }, delayMs: 5, maxDelayMs: 20 });
  return { socket, sockets, opened, logs, auth };
}
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

test('an envelope from the app-token connection becomes a suggested task, is acknowledged, and a redelivery stays single', async () => {
  const f = channelFixture();
  const h = harness(payload => channel.accept(payload));
  const channel = new SlackChannel({ store: f.store, ledger: f.ledger, profileId: PROFILE, team: TEAM, appId: APP, reviewLink: id => `http://127.0.0.1:1/#tarefa=${id}` });
  try {
    f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
    h.socket.start(); await settle();
    assert.deepEqual(h.auth, [`Bearer ${TOKEN}`]);
    const [ws] = h.sockets;
    ws.deliver({ type: 'hello' });
    ws.deliver({ envelope_id: 'env-1', type: 'events_api', payload: event('EvSocket1') });
    ws.deliver({ envelope_id: 'env-1-retry', type: 'events_api', payload: event('EvSocket1'), retry_attempt: 1 });
    assert.deepEqual(ws.sent.map(s => JSON.parse(s)), [{ envelope_id: 'env-1' }, { envelope_id: 'env-1-retry' }]);
    const tasks = f.store.list().tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'suggested');
    assert.deepEqual(h.logs.filter(l => l.startsWith('Slack event')), ['Slack event: task_created.', 'Slack event: duplicate.']);
    assert.ok(!h.logs.join('\n').includes('Pagar') && !h.logs.join('\n').includes(TOKEN), 'logs carry outcomes, never text or token');
  } finally { h.socket.stop(); f.close(); }
});

test('Socket Mode still refuses foreign workspaces and unlisted senders, and signed-HTTP intake is closed without a secret', async () => {
  const f = channelFixture();
  try {
    f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
    const channel = new SlackChannel({ store: f.store, ledger: f.ledger, profileId: PROFILE, team: TEAM, appId: APP, reviewLink: id => id });
    assert.equal(channel.accept(event('EvF', { team_id: 'T0OTHER' })).outcome, 'foreign_workspace');
    assert.equal(channel.accept(event('EvA', { api_app_id: 'A0OTHER' })).outcome, 'foreign_workspace');
    assert.equal(channel.accept({ ...event('EvS'), event: { ...event('EvS').event, user: 'U0STRANGER' } }).outcome, 'unauthorized_sender');
    const raw = JSON.stringify(event('EvH')); const ts = String(Math.floor(Date.now() / 1000));
    const headers = { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', '').update(`v0:${ts}:${raw}`).digest('hex')}` };
    assert.equal(channel.receive(headers, raw).outcome, 'unauthenticated', 'an empty signing secret never authenticates');
    assert.equal(f.store.list().tasks.length, 0);
  } finally { f.close(); }
});

test('an envelope that fails admission is not acknowledged, so Slack redelivers it', async () => {
  const h = harness(() => { throw new Error('database locked'); });
  try {
    h.socket.start(); await settle();
    h.sockets[0].deliver({ envelope_id: 'env-x', type: 'events_api', payload: event('EvX') });
    assert.deepEqual(h.sockets[0].sent, []);
    assert.ok(h.logs.includes('Slack event not admitted: internal error; left for redelivery.'));
  } finally { h.socket.stop(); }
});

test('a refresh disconnect or dropped link reconnects; a rejected token or disabled link stops for good', async () => {
  const ok = harness(() => ({ outcome: 'ignored' }));
  try {
    ok.socket.start(); await settle();
    ok.sockets[0].deliver({ type: 'disconnect', reason: 'refresh_requested' });
    await settle();
    assert.equal(ok.sockets.length, 2, 'refresh opens a new connection');
    ok.sockets[1].close(); await settle();
    assert.equal(ok.sockets.length, 3, 'a dropped link reconnects');
    ok.sockets[2].deliver({ type: 'disconnect', reason: 'link_disabled' });
    await settle(60);
    assert.equal(ok.sockets.length, 3, 'Socket Mode disabled for the app: no reconnect');
  } finally { ok.socket.stop(); }

  const bad = harness(() => ({ outcome: 'ignored' }), [{ ok: false, error: 'invalid_auth' }]);
  try {
    bad.socket.start(); await settle(60);
    assert.equal(bad.opened.length, 1, 'a rejected token is not retried');
    assert.deepEqual(bad.logs, ['Slack Socket Mode connection refused: invalid_auth.']);
  } finally { bad.socket.stop(); }

  const flaky = harness(() => ({ outcome: 'ignored' }), [{ ok: false, error: 'ratelimited' }]);
  try {
    flaky.socket.start(); await settle(60);
    assert.equal(flaky.opened.length, 2, 'a transient refusal is retried');
    assert.equal(flaky.sockets.length, 1);
  } finally { flaky.socket.stop(); }

  const stopped = harness(() => ({ outcome: 'ignored' }));
  stopped.socket.start(); await settle();
  stopped.socket.stop(); await settle(40);
  assert.equal(stopped.sockets.length, 1, 'stop closes without reconnecting');
  assert.throws(() => new SlackSocket({ appToken: 'xoxb-bot-token', accept: () => ({ outcome: 'ignored' }) }), /invalid_app_token/);
});

test('the operator list is the exact authorized set: a sender dropped from it is revoked', () => {
  const f = channelFixture();
  try {
    f.ledger.replaceSenders('slack', TEAM, ['U0OWNER', 'U0SECOND'], 'operador', f.authority);
    assert.equal(f.ledger.authorized('slack', TEAM, 'U0SECOND'), true);
    f.ledger.replaceSenders('slack', TEAM, ['U0OWNER'], 'operador', f.authority);
    assert.equal(f.ledger.authorized('slack', TEAM, 'U0OWNER'), true);
    assert.equal(f.ledger.authorized('slack', TEAM, 'U0SECOND'), false);
    assert.equal(f.ledger.authorized('slack', 'T0OTHER', 'U0OWNER'), false);
    assert.throws(() => f.ledger.replaceSenders('slack', TEAM, ['U0X'], 'x', {}), /unauthorized/);
  } finally { f.close(); }
});
