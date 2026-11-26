import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SlackChannel, type SlackOptions } from '../src/channels/slack.ts';
import { SlackDraftReviews } from '../src/channels/slack-drafts.ts';
import { SlackPoster, SlackRelay } from '../src/channels/slack-relay.ts';
import { createGateway } from '../src/policy/gateway.ts';
import type { Draft, DraftSink } from '../src/connectors/google.ts';
import type { WriteContext } from '../src/connectors/mcp.ts';
import { channelFixture, PROFILE, slackEnvelope } from './channel-support.ts';

const TEAM = 'T0TEST', APP = 'A0TEST', OWNER = 'U0OWNER', DM = 'D0OWNER';
const DRAFT = { kind: 'message', connectionId: 'test-mail', to: ['customer@example.test'], subject: 'Re: Review', body: 'Draft <https://example.test|link> <!channel>\nSecond line.' } as const;
const WRITE = { sessionId: 'session-1', taskId: 'task-1', runId: 'run-1', policyVersion: 'policy-1' };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fakeGoogle(gateway: ReturnType<typeof createGateway>) {
  const effect = (draft: Draft, write: WriteContext) => ({ ...write, version: 1 as const, profileId: PROFILE, adapter: 'google', action: 'gmail.send', account: 'operator@example.test', destination: draft.kind === 'message' ? draft.to.join(',') : 'invalid', payload: Buffer.from(JSON.stringify(draft.kind === 'message' ? { body: draft.body, subject: draft.subject, to: draft.to } : {})) });
  const prepared: string[] = [], invoked: string[] = [];
  const reviews = new Map<string, { reviewId: string; request: ReturnType<typeof effect> }>();
  let refuseNextSend = false;
  const google = {
    prepareSend(draft: Draft, write: WriteContext) {
      prepared.push(write.operationId);
      const request = effect(draft, write), review = gateway.prepare(request);
      if (review.decision === 'review') reviews.set(write.operationId, { reviewId: review.reviewId, request });
      return review;
    },
    send<T>(draft: Draft, write: WriteContext, sink: DraftSink<T>, reviewId?: string) {
      invoked.push(write.operationId);
      assert.ok(reviewId, 'must use the exact gateway review');
      if (refuseNextSend) {
        refuseNextSend = false;
        return Promise.reject(new Error('denied'));
      }
      return gateway.dispatchReviewed(effect(draft, write), reviewId, sink);
    },
  };
  function reviewPending(id: string) {
    const item = reviews.get(id)!;
    return !!gateway.pendingReview(item.reviewId, item.request);
  }
  return { google, prepared, invoked, reviewPending, refuseSend: () => { refuseNextSend = true; } };
}

function fixture(t: TestContext) {
  const f = channelFixture(), authority = {}, feedbackPath = join(f.dir, 'draft-feedback.sqlite');
  const relay = new SlackRelay({ databasePath: join(f.dir, 'relay.sqlite'), profileId: PROFILE });
  for (const user of [OWNER, 'U0OTHER']) f.ledger.authorize('slack', TEAM, user, 'operador', f.authority);
  let time = 1_793_000_000_000;
  const now = () => time;
  const gateway = createGateway({ databasePath: ':memory:', profileId: PROFILE, operatorAuthority: authority, policy: () => 'review', inspect: () => ({ decision: 'review', reasons: [] }), now });
  const { google, ...googleState } = fakeGoogle(gateway);
  const dispatched: { id: string; bytes: string }[] = [];
  type Button = { action_id: string; value: string; text: { text: string } };
  type Block = { type: string; text?: { type: string; text: string }; elements?: Button[] };
  const posts: { url: string; body: { channel: string; text: string; blocks: Block[]; thread_ts?: string }; ts: string }[] = [];
  let refuseNextCard = false;
  const poster = new SlackPoster({ botToken: 'xoxb-test', operator: OWNER, fetch: async (url, init) => {
    const ts = `1793000000.${String(posts.length + 1).padStart(6, '0')}`;
    const body = JSON.parse(String(init?.body));
    if (refuseNextCard && String(url).endsWith('chat.postMessage') && !body.thread_ts) {
      refuseNextCard = false;
      return new Response(JSON.stringify({ ok: false, error: 'invalid_blocks' }));
    }
    posts.push({ url: String(url), body, ts });
    return new Response(JSON.stringify({ ok: true, channel: DM, ts }));
  } });
  const logs: string[] = [];
  let sinkUncertain = false;
  const options = { google, gateway, authority, poster, feedbackPath, ttlMs: 60_000, now, log: (s: string) => logs.push(s), sink: (bytes: Uint8Array, m: { operationId: string }) => {
    dispatched.push({ id: m.operationId, bytes: Buffer.from(bytes).toString() });
    if (sinkUncertain) throw new Error('fake transport lost the response');
  } };
  const drafts = new SlackDraftReviews(options);
  const channelOptions: SlackOptions & { drafts: SlackDraftReviews } = { store: f.store, ledger: f.ledger, profileId: PROFILE, team: TEAM, appId: APP, relay, reviewLink: id => id, drafts };
  const channel = new SlackChannel(channelOptions);
  t.after(() => { drafts.close(); gateway.close(); relay.close(); f.close(); });
  const stage = (body = DRAFT.body as string) => drafts.prepare({ ...DRAFT, to: [...DRAFT.to], body }, WRITE);
  const card = (i = 0) => posts.filter(post => post.url.endsWith('chat.postMessage') && !post.body.thread_ts)[i]!;
  function tap(label: string, index = 0, change: { user?: string; channel?: string; post?: string; value?: string; at?: string; team?: string; app?: string } = {}) {
    const post = card(index);
    const button = post.body.blocks.flatMap(block => block.elements ?? []).find(action => action.text.text === label);
    assert.ok(button, `missing ${label}`);
    const conversation = change.channel ?? DM;
    return channel.accept({ type: 'block_actions', team: { id: change.team ?? TEAM }, api_app_id: change.app ?? APP, user: { id: change.user ?? OWNER }, channel: { id: conversation }, container: { channel_id: conversation, message_ts: change.post ?? post.ts }, actions: [{ ...button, value: change.value ?? button.value, action_ts: change.at ?? '1793000001.000000' }] });
  }
  let replies = 0;
  function reply(text: string, index = 0, user = OWNER) {
    const event = slackEnvelope(`EvReply${++replies}`, text, { user, channel: DM, thread_ts: card(index).ts });
    return channel.accept(event);
  }
  return { stage, card, tap, reply, relay, drafts, options, dispatched, posts, logs, ...googleState,
    refuseCard: () => { refuseNextCard = true; },
    loseSendResponse: () => { sinkUncertain = true; }, advance: (ms: number) => { time += ms; } };
}

test('draft is shown only in the operator DM; typed approval and forged taps never call send', async t => {
  const f = fixture(t);
  const id = await f.stage();
  const card = f.card();
  assert.equal(card.body.channel, OWNER);
  assert.equal(card.body.text.includes('example.test'), false, 'no email content on lock screen');
  assert.deepEqual(card.body.blocks.flatMap(block => block.elements ?? []).map(button => button.text.text), ['Aprovar', 'Editar', 'Descartar']);
  const shown = card.body.blocks.filter(block => block.text?.type === 'plain_text').map(block => block.text!.text).join('\n');
  for (const item of ['operator@example.test', 'customer@example.test', 'Re: Review', '<!channel>', 'Second line.']) assert.ok(shown.includes(item), item);
  assert.equal(f.reply('aprovar').outcome, 'review_required');
  assert.deepEqual(f.relay.after(0, 10), []);
  f.tap('Aprovar', 0, { user: 'U0OTHER' });
  f.tap('Aprovar', 0, { channel: 'C0PUBLIC' });
  f.tap('Aprovar', 0, { channel: 'D0OTHER' });
  f.tap('Aprovar', 0, { team: 'T0FOREIGN' });
  f.tap('Aprovar', 0, { app: 'A0FOREIGN' });
  f.tap('Aprovar', 0, { value: 'not-this-draft' });
  assert.deepEqual(f.prepared, [id]);
  await flush();
  assert.deepEqual(f.invoked, []);
  assert.deepEqual(f.dispatched, []);
});

test('an exact approval only sends its own immutable draft once even across different Slack tap IDs', async t => {
  const f = fixture(t);
  const id = await f.stage(), other = await f.stage('Different body');
  f.tap('Aprovar', 0, { value: other });
  f.tap('Aprovar', 0, { post: f.card(1).ts });
  assert.deepEqual(f.invoked, []);
  assert.equal(f.tap('Aprovar').outcome, 'responded');
  assert.equal(f.tap('Aprovar', 0, { at: '1793000001.000001' }).outcome, 'stale');
  await flush();
  assert.deepEqual(f.invoked, [id]);
  assert.deepEqual(f.dispatched, [{ id, bytes: JSON.stringify({ body: DRAFT.body, subject: DRAFT.subject, to: DRAFT.to }) }]);
  assert.deepEqual(f.posts.at(-1)!.body.blocks, []);
  assert.deepEqual(f.logs, []);
});

test('an uncertain send remains a single attempt and the card does not claim it was sent', async t => {
  const f = fixture(t);
  const id = await f.stage();
  f.loseSendResponse();
  f.tap('Aprovar');
  await flush();
  assert.equal(f.tap('Aprovar', 0, { at: '1793000001.000001' }).outcome, 'stale');
  assert.equal(f.tap('Editar').outcome, 'stale');
  await flush();
  assert.deepEqual(f.prepared, [id]);
  assert.deepEqual(f.invoked, [id]);
  assert.equal(f.dispatched.length, 1);
  assert.match(f.posts.at(-1)!.body.text, /Confira a pasta Enviados.*não reenvie/i);
});

test('a refusal before dispatch keeps a recovery path and only a fresh approval can send', async t => {
  const f = fixture(t);
  const id = await f.stage();
  f.refuseSend();
  f.tap('Aprovar');
  assert.equal(f.tap('Editar').outcome, 'stale', 'no replacements while a send is in flight');
  await flush();
  assert.deepEqual(f.dispatched, []);
  const notice = f.posts.at(-1)!.body;
  assert.match(notice.text, /não foi enviado.*Editar/i);
  assert.equal(notice.channel, DM);
  assert.equal(notice.thread_ts, f.card().ts);
  assert.equal(f.tap('Aprovar').outcome, 'stale', 'old approval or redelivery never sends');
  assert.equal(f.tap('Editar').outcome, 'responded');
  await flush();
  assert.notEqual(f.prepared[1], id);
  assert.deepEqual(f.invoked, [id]);
  f.tap('Aprovar', 1);
  f.tap('Aprovar', 1, { at: '1793000001.000001' });
  await flush();
  assert.deepEqual(f.dispatched, [{ id: f.prepared[1], bytes: JSON.stringify({ body: DRAFT.body, subject: DRAFT.subject, to: DRAFT.to }) }]);
});

test('discard never sends, and records the operator’s reason from the exact DM thread', async t => {
  const f = fixture(t);
  const id = await f.stage();
  await f.stage('Unrelated');
  f.tap('Descartar');
  f.tap('Aprovar');
  await flush();
  assert.match(f.posts.at(-1)!.body.text, /motivo/i);
  f.reply('Outsider feedback', 0, 'U0OTHER');
  f.reply('Wrong thread', 1);
  assert.equal(f.drafts.feedback(id), undefined);
  f.reply('Do not promise a date.');
  f.reply('Do not overwrite.');
  assert.equal(f.drafts.feedback(id), 'Do not promise a date.');
  const reopened = new SlackDraftReviews(f.options);
  try { assert.equal(reopened.feedback(id), 'Do not promise a date.'); } finally { reopened.close(); }
  assert.deepEqual(f.invoked, []);
});

test('a draft expired at the configured deadline refuses its approval', async t => {
  const f = fixture(t);
  await f.stage();
  f.advance(60_000);
  assert.equal(f.tap('Aprovar').outcome, 'stale');
  await flush();
  assert.deepEqual(f.invoked, []);
  assert.deepEqual(f.dispatched, []);
});

test('when Slack refuses the edited card, the old review and replacement text survive until a replacement is ready', async t => {
  const f = fixture(t);
  const id = await f.stage();
  f.tap('Editar');
  f.refuseCard();
  assert.equal(f.reply('Keep this replacement.').outcome, 'responded');
  assert.equal(f.reviewPending(id), true, 'original is not revoked while posting');
  assert.equal(f.tap('Aprovar').outcome, 'stale', 'the original cannot send while replacing it');
  await flush();
  assert.equal(f.reviewPending(id), true, 'failed posting does not revoke the original');
  assert.equal(f.reviewPending(f.prepared[1]!), false, 'failed candidate cannot be approved');
  assert.match(f.posts.at(-1)!.body.text, /texto foi mantido/i);
  assert.equal(f.tap('Editar').outcome, 'responded', 'retry without retyping the replacement');
  await flush();
  assert.equal(f.reviewPending(id), false, 'original revoked only once the new card exists');
  assert.deepEqual(f.invoked, []);
  f.tap('Aprovar', 1);
  await flush();
  assert.deepEqual(f.dispatched, [{ id: f.prepared[2], bytes: JSON.stringify({ body: 'Keep this replacement.', subject: DRAFT.subject, to: DRAFT.to }) }]);
});

test('a replacement confirmed at the expiry deadline cannot be approved', async t => {
  const f = fixture(t);
  await f.stage();
  f.advance(59_999);
  f.tap('Editar');
  f.reply('Replacement at the deadline.');
  f.advance(1);
  await flush();
  assert.equal(f.tap('Aprovar', 1).outcome, 'stale');
  assert.deepEqual(f.prepared.map(f.reviewPending), [false, false]);
  assert.deepEqual(f.invoked, []);
});

test('editing retires the original card; a replacement requires its own tap', async t => {
  const f = fixture(t);
  const id = await f.stage();
  f.tap('Editar');
  f.tap('Aprovar');
  f.reply('Replacement body.');
  await flush();
  assert.equal(f.prepared.length, 2);
  assert.notEqual(f.prepared[1], id);
  assert.deepEqual(f.invoked, []);
  f.tap('Aprovar', 1);
  await flush();
  assert.deepEqual(f.dispatched, [{ id: f.prepared[1], bytes: JSON.stringify({ body: 'Replacement body.', subject: DRAFT.subject, to: DRAFT.to }) }]);
});
