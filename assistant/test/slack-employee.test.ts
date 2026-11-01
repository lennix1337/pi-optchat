import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SlackChannel } from '../src/channels/slack.ts';
import { FORWARD_CHANNEL, SlackPoster, SlackRelay } from '../src/channels/slack-relay.ts';
import { channelFixture, PROFILE, slackEnvelope } from './channel-support.ts';

const TEAM = 'T0TEST'; const APP = 'A0TEST';

function fixture() {
  const f = channelFixture();
  f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
  const relay = new SlackRelay({ databasePath: join(f.dir, 'relay.sqlite'), profileId: PROFILE });
  const channel = new SlackChannel({ store: f.store, ledger: f.ledger, profileId: PROFILE, team: TEAM, appId: APP, relay, relayChannels: new Set(['C0HARNESS']), reviewLink: id => id });
  return { f, relay, channel, close() { relay.close(); f.close(); } };
}

const FILE = { id: 'F0IMG', name: 'tela.png', mimetype: 'image/png', url_private_download: 'https://files.slack.com/files-pri/T0TEST-F0IMG/download/tela.png', size: 10 };

function shortcut(over: Record<string, unknown> = {}) {
  return {
    type: 'message_action', callback_id: 'optchat_forward', trigger_id: '1.2.abc', action_ts: '1793000001.000200',
    team: { id: TEAM, domain: 'lennix' }, api_app_id: APP, user: { id: 'U0OWNER' }, channel: { id: 'C0OTHER', name: 'geral' },
    message: { user: 'U0ALICE', ts: '1793000000.123456', text: 'o deploy quebrou de novo', files: [FILE] }, ...over,
  };
}

test('a file the operator sends in the DM reaches the chat with its attachment, instead of being dropped as file_share', () => {
  const r = fixture();
  try {
    assert.equal(r.channel.accept(slackEnvelope('EvF1', 'olha isso', { subtype: 'file_share', files: [FILE] })).outcome, 'relayed');
    const [m] = r.relay.after(0, 10);
    assert.equal(m!.text, 'olha isso');
    assert.deepEqual(m!.files, [{ id: 'F0IMG', name: 'tela.png', mimetype: 'image/png', url: FILE.url_private_download }]);
    // A file without text is still a message.
    assert.equal(r.channel.accept(slackEnvelope('EvF2', '', { subtype: 'file_share', files: [FILE] })).outcome, 'relayed');
    // Files from outside Slack's file host are not trusted as downloads.
    assert.equal(r.channel.accept(slackEnvelope('EvF3', 'x', { subtype: 'file_share', files: [{ ...FILE, url_private_download: 'https://evil.example/x' }] })).outcome, 'relayed');
    assert.equal(r.relay.after(2, 10)[0]!.files, undefined);
  } finally { r.close(); }
});

test('the "Mandar pro Jarvis" shortcut forwards any message with author, place, link and files to the DM chat', () => {
  const r = fixture();
  try {
    assert.equal(r.channel.accept(shortcut()).outcome, 'relayed');
    assert.equal(r.channel.accept(shortcut()).outcome, 'duplicate', 'a redelivered shortcut stays single');
    const [m] = r.relay.after(0, 10);
    assert.equal(m!.channel, FORWARD_CHANNEL);
    assert.match(m!.text, /Encaminhada por você/);
    assert.match(m!.text, /<@U0ALICE>/);
    assert.match(m!.text, /<#C0OTHER>/);
    assert.match(m!.text, /https:\/\/lennix\.slack\.com\/archives\/C0OTHER\/p1793000000123456/);
    assert.match(m!.text, /o deploy quebrou de novo/);
    assert.equal(m!.files?.length, 1);
    assert.equal(r.channel.accept(shortcut({ user: { id: 'U0STRANGER' } })).outcome, 'unauthorized_sender');
    assert.equal(r.channel.accept(shortcut({ team: { id: 'T0OTHER' } })).outcome, 'foreign_workspace');
    assert.equal(r.channel.accept(shortcut({ callback_id: 'other' })).outcome, 'ignored');
  } finally { r.close(); }
});

function fakeSlack(reply: (url: string, body: unknown) => unknown = () => ({ ok: true })) {
  const calls: { url: string; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? (init.body.startsWith('{') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : undefined;
    calls.push({ url, body });
    if (url.startsWith('https://files.slack.com/')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response(JSON.stringify(reply(url, body)), { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test('poster: reactions, reading a linked message, the home tab, broadcast replies and file downloads', async () => {
  const r = fixture();
  try {
    const slack = fakeSlack(url => url.endsWith('conversations.replies') ? { ok: true, messages: [{ user: 'U0ALICE', text: 'texto original', ts: '1793000000.123456', files: [FILE] }] } : { ok: true, ts: '1.1' });
    const poster = new SlackPoster({ botToken: 'xoxb-test', operator: 'U0OWNER', channels: { harness: 'C0HARNESS' }, fetch: slack.fetch });
    await poster.react('D0OWNER', '1793000000.000100', 'eyes');
    await poster.react('D0OWNER', '1793000000.000100', 'eyes', true);
    assert.deepEqual(slack.calls.map(c => c.url.split('/').pop()), ['reactions.add', 'reactions.remove']);
    await assert.rejects(poster.react('C0STRANGER', '1.1', 'eyes'), /unknown_channel/);
    const linked = await poster.fetchMessage('C0OTHER', '1793000000.123456');
    assert.deepEqual(linked, { user: 'U0ALICE', text: 'texto original', files: [{ id: 'F0IMG', name: 'tela.png', mimetype: 'image/png', url: FILE.url_private_download }] });
    await poster.publishHome('*Trabalhando*');
    const home = slack.calls.at(-1)!;
    assert.equal(home.url, 'https://slack.com/api/views.publish');
    assert.equal(home.body.user_id, 'U0OWNER');
    await poster.send('pronto', '1793000000.000100', undefined, { broadcast: true });
    assert.equal(slack.calls.at(-1)!.body.reply_broadcast, true);
    const saved = await poster.download(FILE.url_private_download, 'tela.png', r.f.dir);
    assert.ok(existsSync(saved.path));
    assert.deepEqual([...readFileSync(saved.path)], [1, 2, 3]);
    await assert.rejects(poster.download('https://evil.example/x', 'x', r.f.dir), /invalid_file_url/);
    const evil = await poster.download(FILE.url_private_download, '../../escape.png', r.f.dir);
    assert.ok(evil.path.startsWith(join(r.f.dir, 'slack-files')), 'a file name never leaves the download folder');
  } finally { r.close(); }
});

test('loopback API: react, fetch, home and download go through the poster; bad shapes are refused', async () => {
  const { createAssistantServer } = await import('../src/http/server.ts');
  const r = fixture();
  const slack = fakeSlack(url => url.endsWith('conversations.replies') ? { ok: true, messages: [{ user: 'U0ALICE', text: 'oi', ts: '1793000000.123456' }] } : { ok: true });
  const poster = new SlackPoster({ botToken: 'xoxb-test', operator: 'U0OWNER', fetch: slack.fetch });
  const server = createAssistantServer({ store: r.f.store, token: 'tok', profileId: PROFILE, slack: { relay: r.relay, poster, filesDir: r.f.dir } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/v1/slack/react', { channel: 'D0OWNER', ts: '1793000000.000100', name: 'eyes', remove: false })).status, 200);
    assert.equal((await post('/v1/slack/react', { channel: 'D0OWNER', ts: '1793000000.000100', name: 'eyes; drop' , remove: false })).status, 400);
    assert.deepEqual(await (await post('/v1/slack/fetch', { channel: 'C0OTHER', ts: '1793000000.123456', thread: '1793000000.123456' })).json(), { user: 'U0ALICE', text: 'oi', files: [] });
    assert.equal((await post('/v1/slack/home', { text: 'livre' })).status, 200);
    const saved = await (await post('/v1/slack/download', { url: FILE.url_private_download, name: 'tela.png' })).json() as { path: string };
    assert.ok(existsSync(saved.path));
    assert.equal((await post('/v1/slack/download', { url: 'https://evil.example/a', name: 'a' })).status, 502);
  } finally { await new Promise(done => server.close(done)); r.close(); }
});
