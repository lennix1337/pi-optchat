import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SlackChannel } from '../src/channels/slack.ts';
import { SlackPoster, SlackRelay, slackText } from '../src/channels/slack-relay.ts';
import { createAssistantServer } from '../src/http/server.ts';
import { channelFixture, PROFILE, slackEnvelope } from './channel-support.ts';

const TEAM = 'T0TEST'; const APP = 'A0TEST'; const TOKEN = 'relay-test-token';

function relayFixture(now = () => 1_793_000_000_000) {
  const f = channelFixture();
  f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
  const relay = new SlackRelay({ databasePath: join(f.dir, 'relay.sqlite'), profileId: PROFILE, now });
  const channel = new SlackChannel({ store: f.store, ledger: f.ledger, profileId: PROFILE, team: TEAM, appId: APP, relay, reviewLink: id => `http://127.0.0.1:1/#tarefa=${id}` });
  return { f, relay, channel, close() { relay.close(); f.close(); } };
}

function fakeSlack() {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, ts: `1793000000.00${calls.length}`, channel: 'D0OWNER' }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test('an operator DM in relay mode is queued for the chat, not turned into a task; redelivery stays single', () => {
  const r = relayFixture();
  try {
    const first = r.channel.accept(slackEnvelope('EvRelay1', 'como ta o deploy?'));
    assert.equal(first.outcome, 'relayed');
    assert.equal(r.channel.accept(slackEnvelope('EvRelay1', 'como ta o deploy?')).outcome, 'duplicate');
    assert.equal(r.f.store.list(null, 10).tasks.length, 0, 'a chat message is not a suggested task');
    const page = r.relay.after(0, 10);
    assert.equal(page.length, 1);
    assert.deepEqual({ ...page[0], receivedAt: undefined }, { seq: 1, sender: 'U0OWNER', channel: 'D0OWNER', ts: '1793000000.000100', thread: null, text: 'como ta o deploy?', receivedAt: undefined });
    assert.equal(r.relay.after(1, 10).length, 0);
  } finally { r.close(); }
});

test('relay keeps the sender and human checks: strangers, bots and edits are not queued', () => {
  const r = relayFixture();
  try {
    assert.equal(r.channel.accept(slackEnvelope('EvX1', 'oi', { user: 'U0STRANGER' })).outcome, 'unauthorized_sender');
    assert.equal(r.channel.accept(slackEnvelope('EvX2', 'oi', { bot_id: 'B1' })).outcome, 'ignored_not_human');
    assert.equal(r.channel.accept(slackEnvelope('EvX3', 'oi', { subtype: 'message_changed' })).outcome, 'ignored_not_human');
    assert.equal(r.channel.accept(slackEnvelope('EvX4', 'oi', {}, { team_id: 'T0OTHER' })).outcome, 'foreign_workspace');
    assert.equal(r.relay.after(0, 10).length, 0);
  } finally { r.close(); }
});

test('the poster sends to the operator DM with the bot token and splits long text', async () => {
  const slack = fakeSlack();
  const poster = new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: slack.fetch });
  const result = await poster.send('a'.repeat(5000));
  assert.equal(result.parts, 2);
  assert.equal(slack.calls.length, 2);
  assert.equal(slack.calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(slack.calls[0].auth, 'Bearer xoxb-disposable');
  assert.equal(slack.calls[0].body.channel, 'U0OWNER');
  assert.ok((slack.calls[0].body.text as string).length <= 3900);
  await poster.send('resposta', '1793000000.000100');
  assert.equal(slack.calls[2].body.thread_ts, '1793000000.000100');
  assert.throws(() => new SlackPoster({ botToken: 'xapp-wrong', operator: 'U0OWNER' }), /invalid_bot_token/);
});

test('slack text converts Markdown emphasis, headings and links to mrkdwn', () => {
  assert.equal(slackText('## Feito\n**PR #13** pronto: [link](https://x.test/a)'), '*Feito*\n*PR #13* pronto: <https://x.test/a|link>');
});

test('when nobody polled recently, a new DM gets one automatic receipt', async () => {
  let now = 1_793_000_000_000;
  const slack = fakeSlack();
  const r = relayFixture(() => now);
  try {
    const poster = new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: slack.fetch });
    r.relay.attach(poster);
    r.relay.after(0, 10); // a reader is present
    now += 10_000;
    r.channel.accept(slackEnvelope('EvOnline', 'oi'));
    await r.relay.idle();
    assert.equal(slack.calls.length, 0, 'an active chat answers by itself');
    now += 10 * 60_000;
    r.channel.accept(slackEnvelope('EvOffline', 'oi de novo'));
    await r.relay.idle();
    assert.equal(slack.calls.length, 1);
    assert.match(String(slack.calls[0].body.text), /fila/);
  } finally { r.close(); }
});

test('HTTP: authenticated inbox paging and send; absent relay is 404', async () => {
  const slack = fakeSlack();
  const r = relayFixture();
  const poster = new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: slack.fetch });
  r.channel.accept(slackEnvelope('EvHttp', 'status?'));
  const server = createAssistantServer({ store: r.f.store, token: TOKEN, profileId: PROFILE, slack: { relay: r.relay, poster } });
  const bare = createAssistantServer({ store: r.f.store, token: TOKEN, profileId: PROFILE });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  await new Promise<void>(done => bare.listen(0, '127.0.0.1', done));
  const base = (s: typeof server) => `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const auth = { authorization: `Bearer ${TOKEN}` };
  try {
    assert.equal((await fetch(`${base(server)}/v1/slack/inbox?after=0`)).status, 401);
    const inbox = await (await fetch(`${base(server)}/v1/slack/inbox?after=0`, { headers: auth })).json() as { messages: { seq: number; text: string }[] };
    assert.deepEqual(inbox.messages.map(m => [m.seq, m.text]), [[1, 'status?']]);
    const sent = await fetch(`${base(server)}/v1/slack/send`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'tudo certo', threadTs: null }) });
    assert.equal(sent.status, 200);
    assert.equal(slack.calls.at(-1)!.body.text, 'tudo certo');
    const badShape = await fetch(`${base(server)}/v1/slack/send`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', channel: 'C0OTHER' }) });
    assert.equal(badShape.status, 400, 'the destination is fixed to the operator');
    assert.equal((await fetch(`${base(server)}/v1/slack/inbox?after=0`, { headers: auth }).then(x => x.status)), 200);
    assert.equal((await fetch(`${base(bare)}/v1/slack/inbox?after=0`, { headers: auth })).status, 404);
  } finally {
    await new Promise(done => server.close(done)); await new Promise(done => bare.close(done)); r.close();
  }
});
