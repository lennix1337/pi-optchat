import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SlackChannel } from '../src/channels/slack.ts';
import { SlackPoster, SlackRelay, slackText } from '../src/channels/slack-relay.ts';
import { createAssistantServer } from '../src/http/server.ts';
import { channelFixture, PROFILE, slackEnvelope } from './channel-support.ts';

const TEAM = 'T0TEST'; const APP = 'A0TEST'; const TOKEN = 'relay-test-token';

const CHANNELS = { dentai: 'C0DENTAI', harness: 'C0HARNESS' };

function relayFixture(now = () => 1_793_000_000_000) {
  const f = channelFixture();
  f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
  const relay = new SlackRelay({ databasePath: join(f.dir, 'relay.sqlite'), profileId: PROFILE, now });
  const channel = new SlackChannel({ store: f.store, ledger: f.ledger, profileId: PROFILE, team: TEAM, appId: APP, relay, relayChannels: new Set(Object.values(CHANNELS)), reviewLink: id => `http://127.0.0.1:1/#tarefa=${id}` });
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

test('operator messages in a configured project channel join the chat; other channels and strangers do not', () => {
  const r = relayFixture();
  try {
    assert.equal(r.channel.accept(slackEnvelope('EvCh1', 'e o deploy?', { channel: 'C0DENTAI' })).outcome, 'relayed');
    assert.equal(r.channel.accept(slackEnvelope('EvCh2', 'oi', { channel: 'C0DENTAI', user: 'U0STRANGER' })).outcome, 'unauthorized_sender');
    assert.equal(r.channel.accept(slackEnvelope('EvCh3', 'oi', { channel: 'C0DENTAI', bot_id: 'B1' })).outcome, 'ignored_not_human', 'the bot\'s own reports are not echoed back');
    assert.notEqual(r.channel.accept(slackEnvelope('EvCh4', 'oi', { channel: 'C0RANDOM' })).outcome, 'relayed');
    assert.deepEqual(r.relay.after(0, 10).map(m => [m.channel, m.text]), [['C0DENTAI', 'e o deploy?']]);
  } finally { r.close(); }
});

test('the poster sends to a configured channel by name and refuses unknown names', async () => {
  const slack = fakeSlack();
  const poster = new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', channels: CHANNELS, fetch: slack.fetch });
  await poster.send('PR #121 mergeada', undefined, 'dentai');
  assert.equal(slack.calls[0].body.channel, 'C0DENTAI');
  await assert.rejects(poster.send('x', undefined, 'C0DENTAI'), /unknown_channel/, 'a raw id is not a name');
  await assert.rejects(poster.send('x', undefined, 'constructor'), /unknown_channel/);
  assert.equal(slack.calls.length, 1);
  assert.equal(poster.nameOf('C0HARNESS'), 'harness');
  assert.equal(poster.nameOf('C0OTHER'), null);
});

test('the offline receipt answers a channel message in that channel, not in the DM', async () => {
  let now = 1_793_000_000_000;
  const slack = fakeSlack();
  const r = relayFixture(() => now);
  try {
    r.relay.attach(new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', channels: CHANNELS, fetch: slack.fetch }));
    now += 10 * 60_000;
    r.channel.accept(slackEnvelope('EvOffCh', 'status?', { channel: 'C0HARNESS' }));
    await r.relay.idle();
    assert.equal(slack.calls.length, 1);
    assert.equal(slack.calls[0].body.channel, 'C0HARNESS');
    assert.equal(slack.calls[0].body.thread_ts, '1793000000.000100');
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

test('right after a service restart the reader gets the grace period before a DM is called offline', async () => {
  // 2026-10-29: the service restarted at 13:29:55, a DM arrived 30 s later while the Pi session was open (its poll was
  // backing off from the restart) and got "OptChat is not open"; the session read it 3 s later.
  let now = 1_793_000_000_000;
  const slack = fakeSlack();
  const r = relayFixture(() => now);
  try {
    r.relay.attach(new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: slack.fetch }));
    now += 30_000;
    r.channel.accept(slackEnvelope('EvAfterRestart', 'aprovar'));
    await r.relay.idle();
    assert.equal(slack.calls.length, 0, 'no reader has had the chance to poll yet');
    now += 3 * 60_000;
    r.channel.accept(slackEnvelope('EvNobody', 'tem alguém?'));
    await r.relay.idle();
    assert.equal(slack.calls.length, 1, 'with no reader for the whole grace period the receipt still goes out');
  } finally { r.close(); }
});

test('HTTP: authenticated inbox paging and send; absent relay is 404', async () => {
  const slack = fakeSlack();
  const r = relayFixture();
  const poster = new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', channels: CHANNELS, fetch: slack.fetch });
  r.channel.accept(slackEnvelope('EvHttp', 'status?'));
  r.channel.accept(slackEnvelope('EvHttpCh', 'e o CI?', { channel: 'C0DENTAI' }));
  const server = createAssistantServer({ store: r.f.store, token: TOKEN, profileId: PROFILE, slack: { relay: r.relay, poster, channels: CHANNELS } });
  const bare = createAssistantServer({ store: r.f.store, token: TOKEN, profileId: PROFILE });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  await new Promise<void>(done => bare.listen(0, '127.0.0.1', done));
  const base = (s: typeof server) => `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const auth = { authorization: `Bearer ${TOKEN}` };
  try {
    assert.equal((await fetch(`${base(server)}/v1/slack/inbox?after=0`)).status, 401);
    const inbox = await (await fetch(`${base(server)}/v1/slack/inbox?after=0`, { headers: auth })).json() as { messages: { seq: number; text: string; channelName: string | null }[] };
    assert.deepEqual(inbox.messages.map(m => [m.seq, m.text, m.channelName]), [[1, 'status?', null], [2, 'e o CI?', 'dentai']]);
    const toChannel = await fetch(`${base(server)}/v1/slack/send`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'verde', threadTs: null, channel: 'dentai' }) });
    assert.equal(toChannel.status, 200);
    assert.equal(slack.calls.at(-1)!.body.channel, 'C0DENTAI');
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

const POST_TS = '1793000000.000200';
function click(action: 'optchat_approve' | 'optchat_deny', actionTs: string, over: Record<string, unknown> = {}) {
  return {
    type: 'block_actions', team: { id: TEAM }, api_app_id: APP, user: { id: 'U0OWNER' }, channel: { id: 'D0OWNER' },
    container: { type: 'message', message_ts: POST_TS, channel_id: 'D0OWNER' },
    message: { ts: POST_TS, text: '⏸ *Aprovação pendente* · bash: rm -rf x' },
    actions: [{ action_id: action, value: action, action_ts: actionTs }], ...over,
  };
}

test('an approval button click from the operator becomes their aprovar/negar in that post\'s thread', async () => {
  const slack = fakeSlack();
  const r = relayFixture();
  try {
    r.relay.attach(new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: slack.fetch }));
    r.relay.after(0, 0); // a reader is present: no offline receipt
    assert.equal(r.channel.accept(click('optchat_approve', '1793000001.000300')).outcome, 'relayed');
    assert.equal(r.channel.accept(click('optchat_approve', '1793000001.000300')).outcome, 'duplicate', 'a redelivered click stays one');
    assert.equal(r.channel.accept(click('optchat_deny', '1793000002.000400')).outcome, 'relayed');
    assert.equal(r.channel.accept(click('optchat_approve', '1793000003.000500', { user: { id: 'U0STRANGER' } })).outcome, 'unauthorized_sender');
    assert.equal(r.channel.accept(click('optchat_approve', '1793000004.000600', { channel: { id: 'C0DENTAI' }, container: { type: 'message', message_ts: POST_TS, channel_id: 'C0DENTAI' } })).outcome, 'ignored', 'approval posts live in the DM');
    assert.equal(r.channel.accept(click('optchat_approve', '1793000005.000700', { team: { id: 'T0OTHER' } })).outcome, 'foreign_workspace');
    assert.deepEqual(r.relay.after(0, 10).map(m => [m.sender, m.thread, m.text]), [['U0OWNER', POST_TS, 'aprovar'], ['U0OWNER', POST_TS, 'negar']]);
    await r.relay.idle();
    const updates = slack.calls.filter(c => c.url === 'https://slack.com/api/chat.update');
    assert.equal(updates.length, 2, 'each admitted click retires the buttons on that post');
    assert.equal(updates[0].body.channel, 'D0OWNER');
    assert.equal(updates[0].body.ts, POST_TS);
    assert.deepEqual(updates[0].body.blocks, []);
    assert.match(String(updates[0].body.text), /Aprovação pendente[\s\S]*Aprovar/);
    assert.equal(slack.calls.length, 2, 'no other post');
  } finally { r.close(); }
});

test('a task review button still points to the authenticated panel, even with the relay on', () => {
  const r = relayFixture();
  try {
    const result = r.channel.accept({ type: 'block_actions', team: { id: TEAM }, api_app_id: APP, user: { id: 'U0OWNER' }, channel: { id: 'D0OWNER' }, container: { message_ts: POST_TS }, actions: [{ action_id: 'approve', value: 'review-1', action_ts: '1793000001.000300' }] });
    assert.equal(result.outcome, 'review_required');
    assert.equal(r.relay.after(0, 10).length, 0);
  } finally { r.close(); }
});

test('an approval post carries Aprovar/Negar buttons under its text', async () => {
  const slack = fakeSlack();
  const poster = new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: slack.fetch });
  await poster.send('⏸ *Aprovação pendente* · bash: rm', undefined, undefined, { approval: true });
  const body = slack.calls[0].body as { text: string; blocks: { type: string; text?: { text: string }; elements?: { action_id: string; text: { text: string } }[] }[] };
  assert.equal(body.text, '⏸ *Aprovação pendente* · bash: rm', 'the notification keeps the text');
  assert.equal(body.blocks[0].type, 'section');
  assert.equal(body.blocks[0].text!.text, '⏸ *Aprovação pendente* · bash: rm');
  assert.deepEqual(body.blocks[1].elements!.map(e => [e.action_id, e.text.text]), [['optchat_approve', 'Aprovar'], ['optchat_deny', 'Negar']]);
  await poster.send('normal');
  assert.equal(slack.calls[1].body.blocks, undefined);
});

test('HTTP: send returns the DM id of the post, and update rewrites only a DM post, dropping its buttons', async () => {
  // 2026-10-29: an approval decided at the terminal left its Slack post saying "Aprovação pendente" with live buttons.
  const slack = fakeSlack();
  const r = relayFixture();
  const poster = new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', channels: CHANNELS, fetch: slack.fetch });
  const server = createAssistantServer({ store: r.f.store, token: TOKEN, profileId: PROFILE, slack: { relay: r.relay, poster, channels: CHANNELS } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const sent = await (await post('/v1/slack/send', { text: 'pendente', threadTs: null, approval: true })).json() as { ts: string; channel?: string };
    assert.equal(sent.channel, 'D0OWNER');
    assert.equal((await post('/v1/slack/update', { channel: 'D0OWNER', ts: sent.ts, text: '✅ Aprovado no terminal' })).status, 200);
    const update = slack.calls.at(-1)!;
    assert.equal(update.url, 'https://slack.com/api/chat.update');
    assert.deepEqual([update.body.channel, update.body.ts, update.body.text, update.body.blocks], ['D0OWNER', sent.ts, '✅ Aprovado no terminal', []]);
    const calls = slack.calls.length;
    for (const body of [{ channel: 'C0DENTAI', ts: sent.ts, text: 'x' }, { channel: 'D0OWNER', ts: 'nope', text: 'x' }, { channel: 'D0OWNER', ts: sent.ts }, { channel: 'D0OWNER', ts: sent.ts, text: 'x', extra: 1 }])
      assert.equal((await post('/v1/slack/update', body)).status, 400, `reject ${JSON.stringify(body)}`);
    assert.equal(slack.calls.length, calls, 'a refused update reaches no Slack API');
  } finally { await new Promise(done => server.close(done)); r.close(); }
});

test('HTTP: send accepts the approval flag and passes it to the poster', async () => {
  const slack = fakeSlack();
  const r = relayFixture();
  const poster = new SlackPoster({ botToken: 'xoxb-disposable', operator: 'U0OWNER', fetch: slack.fetch });
  const server = createAssistantServer({ store: r.f.store, token: TOKEN, profileId: PROFILE, slack: { relay: r.relay, poster } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/slack/send`;
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text: 'pendente', threadTs: null, approval: true }) })).status, 200);
    assert.equal((slack.calls[0].body.blocks as unknown[]).length, 2);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text: 'x', threadTs: null, approval: 'yes' }) })).status, 400);
  } finally { await new Promise(done => server.close(done)); r.close(); }
});
