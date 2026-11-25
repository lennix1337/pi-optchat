import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SlackChannel } from '../src/channels/slack.ts';
import { SlackPoster, SlackRelay, preview } from '../src/channels/slack-relay.ts';
import { createAssistantServer } from '../src/http/server.ts';
import { extractPlan, planBlocks, planPreview, planProgress } from '../src/channels/plan-card.ts';
import { channelFixture, PROFILE } from './channel-support.ts';

const TEAM = 'T0TEST'; const APP = 'A0TEST'; const TOKEN = 'plan-test-token';
const POST_TS = '1793000000.000200';
const PLAN = '# Migrar o relatório\n1. Ler o esquema atual\n2. Escrever a migração\n3. Rodar os testes';
const MESSAGE = `Pensei assim.\n<proposed_plan>\n${PLAN}\n</proposed_plan>\nMe diga se serve.`;

type Block = { type: string; text?: { text: string }; elements?: { action_id?: string; value?: string; text: { text: string }; style?: string }[] };

function fakeSlack() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, ts: `1793000000.00${calls.length}`, channel: 'D0OWNER' }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}
const poster = (fetch: typeof globalThis.fetch) => new SlackPoster({ botToken: 'xoxb-plan-test', operator: 'U0OWNER', channels: { dentai: 'C0DENTAI' }, fetch });

test('a proposed plan in the DM becomes a card: header, checklist, Implementar and Ajustar plano; the tags never show', async () => {
  const slack = fakeSlack();
  await poster(slack.fetch).send(MESSAGE);
  const body = slack.calls[0]!.body as { text: string; blocks: Block[] };
  assert.equal(body.blocks[0]!.type, 'header');
  assert.equal(body.blocks[0]!.text!.text, 'Plano proposto \u00b7 0/3');
  const shown = body.blocks.filter(b => b.type === 'section').map(b => b.text!.text).join('\n');
  assert.doesNotMatch(shown, /proposed_plan/);
  assert.match(shown, /Pensei assim/); assert.match(shown, /Me diga se serve/);
  assert.match(shown, /\u2b1c Ler o esquema atual/); assert.match(shown, /\u2b1c Rodar os testes/);
  const actions = body.blocks.at(-1)!;
  assert.equal(actions.type, 'actions');
  assert.deepEqual(actions.elements!.map(e => [e.action_id, e.text.text, e.style]), [['optchat_plan_implement', 'Implementar', 'primary'], ['optchat_plan_adjust', 'Ajustar plano', undefined]]);
  assert.match(actions.elements![0]!.value!, /^plano:[0-9a-f]{8}:Migrar o relat\u00f3rio$/);
  assert.match(body.text, /^Plano proposto: Migrar o relat\u00f3rio \u00b7 0\/3/, 'the notification opens with the plan, not with the card');
});

test('a plan posted to a project channel is a card without buttons; a message with no plan stays plain', async () => {
  const slack = fakeSlack();
  const p = poster(slack.fetch);
  await p.send(MESSAGE, undefined, 'dentai');
  assert.equal((slack.calls[0]!.body.blocks as Block[]).some(b => b.type === 'actions'), false);
  await p.send('só texto');
  assert.equal(slack.calls[1]!.body.blocks, undefined);
  await p.send('<proposed_plan>sem passos</proposed_plan>', undefined, undefined, { approval: true });
  assert.doesNotMatch(String(slack.calls[2]!.body.text), /proposed_plan/);
});

test('the checklist shows done, current and next steps, with the N/M count', () => {
  const plan = extractPlan('<proposed_plan>\n- [x] Ler\n- [ ] Escrever\n- [ ] Testar\n</proposed_plan>')!;
  assert.deepEqual(planProgress(plan.plan), { done: 1, total: 3 });
  const blocks = planBlocks(plan, { actions: true }) as Block[];
  assert.equal(blocks[0]!.text!.text, 'Plano proposto \u00b7 1/3');
  assert.equal(blocks.some(b => b.type === 'actions'), false, 'once a step is ticked the buttons give way to the progress');
  assert.equal(blocks[1]!.text!.text, '\u2714 ~Ler~\n\u25b6\ufe0f *Escrever*\n\u2b1c Testar');
  assert.equal(planPreview(plan.plan), 'Plano proposto: Ler \u00b7 1/3');
});

test('the lock-screen text of a post with blocks opens with its first line, short', () => {
  assert.equal(preview('\u23f8 *Aprovação pendente* \u00b7 bash: rm\nmais detalhes\ne mais'), '\u23f8 *Aprovação pendente* \u00b7 bash: rm');
  assert.equal(preview('<https://github.com/x/y/pull/1|PR #1> mergeado'), 'PR #1 mergeado');
  assert.ok(preview('a'.repeat(500)).length <= 120);
});

function relayFixture() {
  const f = channelFixture();
  f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
  const relay = new SlackRelay({ databasePath: join(f.dir, 'relay.sqlite'), profileId: PROFILE, now: () => 1_793_000_000_000 });
  const channel = new SlackChannel({ store: f.store, ledger: f.ledger, profileId: PROFILE, team: TEAM, appId: APP, relay, relayChannels: new Set(['C0DENTAI']), reviewLink: id => `http://127.0.0.1:1/#tarefa=${id}` });
  return { f, relay, channel, close() { relay.close(); f.close(); } };
}

function planClick(action: string, actionTs: string, value: string, blocks: unknown[], over: Record<string, unknown> = {}) {
  return { type: 'block_actions', team: { id: TEAM }, api_app_id: APP, user: { id: 'U0OWNER' }, channel: { id: 'D0OWNER' },
    container: { type: 'message', message_ts: POST_TS, channel_id: 'D0OWNER' }, message: { ts: POST_TS, text: 'Plano proposto: Migrar', blocks },
    actions: [{ action_id: action, value, action_ts: actionTs }], ...over };
}

test('tapping Implementar answers that plan only, in its thread, and the card keeps its text but loses the buttons', async () => {
  const slack = fakeSlack();
  const r = relayFixture();
  try {
    r.relay.attach(poster(slack.fetch));
    r.relay.after(0, 0);
    await poster(slack.fetch).send(MESSAGE);
    const blocks = (slack.calls[0]!.body as { blocks: Block[] }).blocks;
    const value = blocks.at(-1)!.elements![0]!.value!;
    assert.equal(r.channel.accept(planClick('optchat_plan_implement', '1793000001.000300', value, blocks)).outcome, 'relayed');
    assert.equal(r.channel.accept(planClick('optchat_plan_implement', '1793000001.000300', value, blocks)).outcome, 'duplicate');
    assert.equal(r.channel.accept(planClick('optchat_plan_implement', '1793000002.000400', value, blocks, { user: { id: 'U0STRANGER' } })).outcome, 'unauthorized_sender');
    assert.equal(r.channel.accept(planClick('optchat_plan_implement', '1793000003.000500', 'forjado', blocks)).outcome, 'ignored', 'a value that does not name a plan is not a tap on one');
    assert.equal(r.channel.accept(planClick('optchat_plan_implement', '1793000004.000600', value, blocks, { channel: { id: 'C0DENTAI' }, container: { type: 'message', message_ts: POST_TS, channel_id: 'C0DENTAI' } })).outcome, 'ignored');
    const [message] = r.relay.after(0, 10);
    assert.equal(r.relay.after(0, 10).length, 1);
    assert.equal(message!.thread, POST_TS);
    assert.match(message!.text, /^Implementar o plano "Migrar o relat\u00f3rio" \(plano [0-9a-f]{8}\)\.$/);
    await r.relay.idle();
    const update = slack.calls.find(c => c.url === 'https://slack.com/api/chat.update')!;
    const kept = update.body.blocks as Block[];
    assert.equal(kept.some(b => b.type === 'actions'), false);
    assert.equal(kept[0]!.type, 'header', 'the plan stays on the card');
    assert.match(String(kept.at(-1)!.elements![0]!.text), /Você tocou em \*Implementar\*/);
  } finally { r.close(); }
});

test('Ajustar plano asks what to change instead of implementing', () => {
  const r = relayFixture();
  try {
    const value = 'plano:0123abcd:Migrar';
    assert.equal(r.channel.accept(planClick('optchat_plan_adjust', '1793000001.000300', value, [])).outcome, 'relayed');
    assert.match(r.relay.after(0, 10)[0]!.text, /^Ajustar o plano "Migrar" \(plano 0123abcd\): pergunte o que eu quero mudar/);
  } finally { r.close(); }
});

test('HTTP: /v1/slack/plan redraws a DM card with its progress and no buttons; anything else is refused', async () => {
  const slack = fakeSlack();
  const r = relayFixture();
  const server = createAssistantServer({ store: r.f.store, token: TOKEN, profileId: PROFILE, slack: { relay: r.relay, poster: poster(slack.fetch), channels: { dentai: 'C0DENTAI' } } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown) => fetch(`${base}/v1/slack/plan`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const text = '<proposed_plan>\n- [x] Ler\n- [ ] Escrever\n</proposed_plan>';
    assert.equal((await post({ channel: 'D0OWNER', ts: POST_TS, text })).status, 200);
    const update = slack.calls.at(-1)!;
    assert.equal(update.url, 'https://slack.com/api/chat.update');
    assert.equal((update.body.blocks as Block[])[0]!.text!.text, 'Plano proposto \u00b7 1/2');
    assert.equal((update.body.blocks as Block[]).some(b => b.type === 'actions'), false);
    const calls = slack.calls.length;
    assert.equal((await post({ channel: 'C0DENTAI', ts: POST_TS, text })).status, 400);
    assert.equal((await post({ channel: 'D0OWNER', ts: POST_TS, text: 'sem plano' })).status, 502);
    assert.equal(slack.calls.length, calls, 'a refused redraw reaches no Slack API');
  } finally { await new Promise(done => server.close(done)); r.close(); }
});
