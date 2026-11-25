import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SlackChannel } from '../src/channels/slack.ts';
import { SlackPoster, SlackRelay } from '../src/channels/slack-relay.ts';
import { createAssistantServer } from '../src/http/server.ts';
import { channelFixture, PROFILE } from './channel-support.ts';

const BOT_TOKEN = ['xoxb', 'disposable', 'fixture'].join('-');
const TEAM = 'T0TEST'; const APP = 'A0TEST'; const TOKEN = 'buttons-test-token';
const CHANNELS = { dentai: 'C0DENTAI' };
const QUESTION_TS = '1793000000.000200';
const QUESTION = 'Qual caminho para a migração?\nA é mais rápida.';

function fixture() {
  const f = channelFixture();
  f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
  const relay = new SlackRelay({ databasePath: join(f.dir, 'relay.sqlite'), profileId: PROFILE, now: () => 1_793_000_000_000 });
  const channel = new SlackChannel({ store: f.store, ledger: f.ledger, profileId: PROFILE, team: TEAM, appId: APP, relay, relayChannels: new Set(Object.values(CHANNELS)), reviewLink: id => `http://127.0.0.1:1/#tarefa=${id}` });
  const calls: { url: string; body: Record<string, any> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, ts: `1793000000.00${calls.length}`, channel: 'D0OWNER' }), { status: 200 });
  }) as typeof globalThis.fetch;
  const poster = new SlackPoster({ botToken: BOT_TOKEN, operator: 'U0OWNER', channels: CHANNELS, fetch });
  relay.attach(poster);
  return { f, relay, channel, poster, calls, close() { relay.close(); f.close(); } };
}

function choiceTap(index: number, label: string, actionTs: string, over: Record<string, unknown> = {}) {
  return {
    type: 'block_actions', team: { id: TEAM }, api_app_id: APP, user: { id: 'U0OWNER' }, channel: { id: 'D0OWNER' },
    container: { type: 'message', message_ts: QUESTION_TS, channel_id: 'D0OWNER' }, message: { ts: QUESTION_TS, text: QUESTION },
    actions: [{ action_id: `optchat_choice_${index}`, value: label, action_ts: actionTs }], ...over,
  };
}

type Block = { type: string; text?: { text: string }; elements?: { action_id: string; value: string; style?: string; text: { text: string }; confirm?: { text: { text: string } } }[] };

test('choices render as at most five buttons under the question: the first is primary, a denial is danger', async () => {
  const r = fixture();
  try {
    await r.poster.send(QUESTION, undefined, undefined, { choices: ['Caminho A (recomendado)', 'Caminho B', 'Parar'] });
    const body = r.calls[0]!.body as { text: string; blocks: Block[] };
    assert.equal(body.text, QUESTION, 'the notification keeps the question text');
    assert.deepEqual(body.blocks.map(b => b.type), ['section', 'actions']);
    assert.deepEqual(body.blocks[1]!.elements!.map(e => [e.action_id, e.text.text, e.value, e.style]), [
      ['optchat_choice_0', 'Caminho A (recomendado)', 'Caminho A (recomendado)', 'primary'],
      ['optchat_choice_1', 'Caminho B', 'Caminho B', undefined],
      ['optchat_choice_2', 'Parar', 'Parar', 'danger'],
    ]);
    await r.poster.send('Aviso', undefined, 'dentai', { choices: ['Sim', 'Não'] });
    const channelPost = r.calls[1]!.body as { channel: string; blocks: Block[] };
    assert.equal(channelPost.channel, 'C0DENTAI');
    assert.deepEqual(channelPost.blocks[1]!.elements!.map(e => e.style), ['primary', 'danger'], '"Não" reads as a denial');
  } finally { r.close(); }
});

test('choices outside 2..5 labels, duplicated, empty, too long or mixed with an approval never reach Slack', async () => {
  const r = fixture();
  try {
    for (const choices of [['Só uma'], ['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'a'], ['a', ' '], ['a', 'x'.repeat(76)]])
      await assert.rejects(r.poster.send('Pergunta', undefined, undefined, { choices }), /invalid_choices/, JSON.stringify(choices));
    await assert.rejects(r.poster.send('Pergunta', undefined, undefined, { approval: true, choices: ['a', 'b'] }), /invalid_choices/);
    assert.equal(r.calls.length, 0);
    await r.poster.send('Pergunta', undefined, undefined, { choices: ['a', 'b', 'c', 'd', 'e'] });
    assert.equal(r.calls.length, 1, 'five is the limit and still goes out');
  } finally { r.close(); }
});

test('a long question keeps its buttons on the last part, never on a part over the section limit', async () => {
  const r = fixture();
  try {
    await r.poster.send('palavra '.repeat(900), undefined, undefined, { choices: ['Sim', 'Não'] });
    const withBlocks = r.calls.filter(c => c.body.blocks);
    assert.equal(withBlocks.length, 1);
    assert.equal(r.calls.at(-1)!.body.blocks, withBlocks[0]!.body.blocks, 'the last part carries the buttons');
    for (const block of withBlocks[0]!.body.blocks as Block[]) if (block.text) assert.ok(block.text.text.length <= 3000);
  } finally { r.close(); }
});

test('HTTP: send accepts choices and rejects a bad list before Slack', async () => {
  const r = fixture();
  const server = createAssistantServer({ store: r.f.store, token: TOKEN, profileId: PROFILE, slack: { relay: r.relay, poster: r.poster, channels: CHANNELS } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/slack/send`;
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ text: 'Qual?', threadTs: null, choices: ['Sim', 'Não'] })).status, 200);
    assert.equal((r.calls[0]!.body.blocks as Block[])[1]!.elements!.length, 2);
    const before = r.calls.length;
    for (const choices of [['Só uma'], ['a', 'b', 'c', 'd', 'e', 'f'], 'sim', [1, 2], ['a', 'a']]) assert.equal((await post({ text: 'Qual?', threadTs: null, choices })).status, 400, JSON.stringify(choices));
    assert.equal((await post({ text: 'Qual?', threadTs: null, approval: true, choices: ['a', 'b'] })).status, 502, 'approval and choices cannot mix');
    assert.equal(r.calls.length, before);
    assert.equal((await post({ text: 'x', threadTs: null, sessionAllow: 'git -C c:/a push origin main', approval: true })).status, 200);
    assert.equal(((r.calls.at(-1)!.body.blocks as Block[])[1]!.elements!).length, 3);
  } finally { await new Promise(done => server.close(done)); r.close(); }
});

test('tapping a choice becomes the operator\'s reply naming the question, and the buttons are retired with the chosen label', async () => {
  const r = fixture();
  try {
    r.relay.after(0, 0);
    assert.equal(r.channel.accept(choiceTap(1, 'Caminho B', '1793000001.000300')).outcome, 'relayed');
    assert.equal(r.channel.accept(choiceTap(1, 'Caminho B', '1793000001.000300')).outcome, 'duplicate', 'a redelivered tap stays one');
    assert.equal(r.channel.accept(choiceTap(0, 'Caminho A', '1793000002.000400')).outcome, 'duplicate', 'a second button on the same question is no second answer');
    assert.equal(r.channel.accept(choiceTap(0, 'Caminho A', '1793000003.000500', { user: { id: 'U0STRANGER' } })).outcome, 'unauthorized_sender');
    assert.equal(r.channel.accept(choiceTap(0, 'Caminho A', '1793000004.000600', { team: { id: 'T0OTHER' } })).outcome, 'foreign_workspace');
    assert.equal(r.channel.accept(choiceTap(0, 'Caminho A', '1793000005.000700', { channel: { id: 'C0OTHER' }, container: { type: 'message', message_ts: '1793000000.000900', channel_id: 'C0OTHER' } })).outcome, 'ignored', 'only the DM and configured channels');
    assert.equal(r.channel.accept(choiceTap(0, 'x'.repeat(200), '1793000006.000800', { container: { type: 'message', message_ts: '1793000000.000901', channel_id: 'D0OWNER' } })).outcome, 'ignored', 'a label beyond the button limit is not a choice');
    const messages = r.relay.after(0, 10);
    assert.deepEqual(messages.map(m => [m.sender, m.channel, m.thread, m.text]), [['U0OWNER', 'D0OWNER', null, 'Sobre "Qual caminho para a migração?": Caminho B']]);
    assert.ok(!/^(aprovar|negar)/.test(messages[0]!.text), 'a choice is never an approval');
    await r.relay.idle();
    const updates = r.calls.filter(c => c.url === 'https://slack.com/api/chat.update');
    assert.equal(updates.length, 1);
    assert.deepEqual([updates[0]!.body.channel, updates[0]!.body.ts, updates[0]!.body.blocks], ['D0OWNER', QUESTION_TS, []]);
    assert.match(String(updates[0]!.body.text), /Qual caminho para a migração[\s\S]*→ Escolhido: \*Caminho B\*/);
  } finally { r.close(); }
});

test('a choice tapped in a project channel is a channel message there and is retired in that channel', async () => {
  const r = fixture();
  try {
    const tap = choiceTap(0, 'Sim', '1793000001.000300', { channel: { id: 'C0DENTAI' }, container: { type: 'message', message_ts: QUESTION_TS, channel_id: 'C0DENTAI', thread_ts: '1793000000.000100' } });
    assert.equal(r.channel.accept(tap).outcome, 'relayed');
    assert.deepEqual(r.relay.after(0, 10).map(m => [m.channel, m.thread]), [['C0DENTAI', '1793000000.000100']]);
    await r.relay.idle();
    assert.equal(r.calls.length, 1);
    assert.deepEqual([r.calls[0]!.url, r.calls[0]!.body.channel, r.calls[0]!.body.ts], ['https://slack.com/api/chat.update', 'C0DENTAI', QUESTION_TS]);
  } finally { r.close(); }
});

test('the approval card has Aprovar (primary) and Negar (danger), and a session button only when a scope is named, behind a confirmation', async () => {
  const r = fixture();
  try {
    await r.poster.send('⏸ *Aprovação pendente* · push', undefined, undefined, { approval: true });
    assert.deepEqual(((r.calls[0]!.body.blocks as Block[])[1]!.elements!).map(e => [e.action_id, e.style]), [['optchat_approve', 'primary'], ['optchat_deny', 'danger']]);
    await r.poster.send('⏸ *Aprovação pendente* · push', undefined, undefined, { approval: true, sessionAllow: 'git -C c:/projetos/x push origin main' });
    const elements = (r.calls[1]!.body.blocks as Block[])[1]!.elements!;
    assert.deepEqual(elements.map(e => [e.action_id, e.text.text, e.style]), [['optchat_approve', 'Aprovar', 'primary'], ['optchat_approve_session', 'Aprovar nesta sessão', undefined], ['optchat_deny', 'Negar', 'danger']]);
    assert.match(elements[1]!.confirm!.text.text, /Libera só: git -C c:\/projetos\/x push origin main\..*qualquer outra chamada continua pedindo aprovação/);
    await r.poster.send('sem aprovação', undefined, undefined, { sessionAllow: 'git -C c:/x push origin main' });
    assert.equal(r.calls[2]!.body.blocks, undefined, 'a session scope without an approval card adds no button');
  } finally { r.close(); }
});

test('tapping the session button becomes the operator\'s "aprovar sessão" in the card\'s thread and retires the card', async () => {
  const r = fixture();
  try {
    const tap = { type: 'block_actions', team: { id: TEAM }, api_app_id: APP, user: { id: 'U0OWNER' }, channel: { id: 'D0OWNER' },
      container: { type: 'message', message_ts: QUESTION_TS, channel_id: 'D0OWNER' }, message: { ts: QUESTION_TS, text: '⏸ *Aprovação pendente* · push' },
      actions: [{ action_id: 'optchat_approve_session', value: 'optchat_approve_session', action_ts: '1793000001.000300' }] };
    assert.equal(r.channel.accept(tap).outcome, 'relayed');
    assert.deepEqual(r.relay.after(0, 10).map(m => [m.sender, m.thread, m.text]), [['U0OWNER', QUESTION_TS, 'aprovar sessão']]);
    await r.relay.idle();
    assert.deepEqual(r.calls[0]!.body.blocks, []);
    assert.match(String(r.calls[0]!.body.text), /Você tocou em \*Aprovar nesta sessão\*/);
  } finally { r.close(); }
});
