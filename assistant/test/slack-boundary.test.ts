import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SlackChannel, verifySlack } from '../src/channels/slack.ts';
import { channelFixture, PROFILE } from './channel-support.ts';

const SECRET = 'disposable-slack-signing-secret';
const NOW = 1_793_000_000_000;
const TEAM = 'T0TEST'; const APP = 'A0TEST';
function signed(body: unknown, at = NOW, secret = SECRET) {
  const raw = JSON.stringify(body); const ts = String(Math.floor(at / 1000));
  return { raw, headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}` } };
}
const message = (over: Record<string, unknown> = {}, eventId = `Ev${Math.random().toString(36).slice(2)}`) => ({
  type: 'event_callback', team_id: TEAM, api_app_id: APP, event_id: eventId,
  event: { type: 'message', channel: 'D0OWNER', user: 'U0OWNER', text: 'Revisar contrato do aluguel', ts: '1793000000.000100', ...over },
});
function slack(f: ReturnType<typeof channelFixture>) {
  return new SlackChannel({ store: f.store, ledger: f.ledger, profileId: PROFILE, team: TEAM, appId: APP, signingSecret: SECRET, now: () => NOW, reviewLink: taskId => `http://127.0.0.1:1/#tarefa=${encodeURIComponent(taskId)}` });
}

test('signature, timestamp window and body integrity are checked before anything is parsed', () => {
  const { raw, headers } = signed(message());
  assert.equal(verifySlack(headers, raw, SECRET, NOW), true);
  assert.equal(verifySlack(headers, raw + ' ', SECRET, NOW), false);
  assert.equal(verifySlack(headers, raw, 'other-secret', NOW), false);
  assert.equal(verifySlack(headers, raw, SECRET, NOW + 6 * 60_000), false, 'replayed outside the 5-minute window');
  assert.equal(verifySlack({ ...headers, 'x-slack-signature': 'v0=00' }, raw, SECRET, NOW), false);
  assert.equal(verifySlack({}, raw, SECRET, NOW), false);
});

test('a signed message from an authorized sender becomes one suggested task with provenance; replay and restart do not duplicate', () => {
  const f = channelFixture();
  try {
    f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
    const body = message({}, 'EvOnce');
    const { raw, headers } = signed(body);
    const result = slack(f).receive(headers, raw);
    assert.equal(result.outcome, 'task_created');
    const task = f.store.get(result.taskId!)!;
    assert.equal(task.status, 'suggested', 'a remote message suggests work; it does not start it');
    const [entry] = f.store.events(0, 10);
    assert.equal(entry.event.source.sourceKind, 'external');
    assert.equal(entry.event.source.actorId, `slack:${TEAM}:U0OWNER`);
    assert.equal(entry.event.channelId, 'slack:D0OWNER');
    assert.equal(entry.event.evidence.reference, `slack://${TEAM}/D0OWNER/1793000000.000100`);
    assert.equal(slack(f).receive(headers, raw).outcome, 'duplicate');
    f.reopen();
    assert.equal(slack(f).receive(headers, raw).outcome, 'duplicate', 'replay protection survives restart');
    assert.equal(f.store.list().tasks.length, 1);
  } finally { f.close(); }
});

test('foreign workspace, foreign app, unknown or revoked sender, bots and edits never act', () => {
  const f = channelFixture();
  try {
    f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
    const outcome = (body: unknown) => { const { raw, headers } = signed(body); return slack(f).receive(headers, raw).outcome; };
    assert.equal(outcome({ ...message(), team_id: 'T0OTHER' }), 'foreign_workspace');
    assert.equal(outcome({ ...message(), api_app_id: 'A0OTHER' }), 'foreign_workspace');
    assert.equal(outcome(message({ user: 'U0STRANGER' })), 'unauthorized_sender');
    assert.equal(outcome(message({ bot_id: 'B0BOT' })), 'ignored_not_human');
    assert.equal(outcome(message({ subtype: 'message_changed' })), 'ignored_not_human');
    assert.equal(outcome(message({ subtype: 'bot_message' })), 'ignored_not_human');
    f.ledger.revoke('slack', TEAM, 'U0OWNER', f.authority);
    assert.equal(outcome(message()), 'unauthorized_sender', 'revoked identity');
    const { raw, headers } = signed(message(), NOW, 'wrong');
    assert.equal(slack(f).receive(headers, raw).outcome, 'unauthenticated');
    assert.equal(f.store.list().tasks.length, 0);
    assert.throws(() => f.ledger.authorize('slack', TEAM, 'U0X', 'x', {}), /unauthorized/, 'only the local operator manages senders');
  } finally { f.close(); }
});

test('a thread reply answers only the input it was asked for; a stale or foreign thread does not', () => {
  const f = channelFixture();
  try {
    f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
    const task = f.needsInput();
    f.ledger.recordThread({ platform: 'slack', account: TEAM, conversation: 'D0OWNER', thread: '1793000000.000900', taskId: task.taskId, revision: task.revision, inputRevision: task.inputRevision });
    const reply = (text: string, thread = '1793000000.000900') => { const { raw, headers } = signed(message({ text, thread_ts: thread, ts: `${Date.now()}.${Math.random()}` })); return slack(f).receive(headers, raw); };
    assert.equal(reply('Fornecedor B').outcome, 'responded');
    assert.equal(f.store.get(task.taskId)!.status, 'working');
    assert.equal(reply('Na verdade C').outcome, 'stale', 'the input was already answered');
    f.askAgain(task.taskId);
    assert.equal(reply('resposta antiga para a pergunta nova').outcome, 'stale', 'an old thread cannot answer a newer question');
    assert.equal(reply('outra thread', '1793000000.000111').outcome, 'task_created', 'an unknown thread is a new suggestion, not an answer');
  } finally { f.close(); }
});
