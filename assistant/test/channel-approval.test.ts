import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { Gateway, type EffectMetadata } from '../src/policy/gateway.ts';
import { inspectEgress } from '../src/policy/egress.ts';
import { ChannelSender } from '../src/channels/inbound.ts';
import { SlackChannel } from '../src/channels/slack.ts';
import { channelFixture, PROFILE } from './channel-support.ts';

const NOW = 1_793_000_000_000;
const TEAM = 'T0TEST';
const SECRET = 'disposable-slack-signing-secret';
const CANARY = 'sk-live-CANARY-0123456789abcdef';
function gateway(dir: string, authority: object, policy: (m: EffectMetadata) => 'allow' | 'review' | 'deny' = () => 'review') {
  return new Gateway({ databasePath: join(dir, 'gateway.sqlite'), profileId: PROFILE, operatorAuthority: authority, policy, inspect: bytes => inspectEgress(bytes, [CANARY]), now: () => NOW });
}
const notice = (taskId: string, over: Record<string, unknown> = {}) => ({ operationId: `op-${taskId}`, platform: 'slack' as const, account: TEAM, conversation: 'D0OWNER', taskId, text: 'Sua decis\u00e3o \u00e9 necess\u00e1ria: Escolher fornecedor', expiresAt: NOW + 60_000, ...over });

test('approve buttons and "aprovar" text never decide an effect; they point to the authenticated review', async () => {
  const f = channelFixture();
  const g = gateway(f.dir, f.authority);
  try {
    f.ledger.authorize('slack', TEAM, 'U0OWNER', 'operador', f.authority);
    const task = f.needsInput();
    const review = g.prepare({ version: 1, operationId: 'pay-1', profileId: PROFILE, sessionId: 's', taskId: task.taskId, runId: 'r', adapter: 'bank', action: 'pay', account: 'acct', destination: 'vendor', policyVersion: '1', expiresAt: NOW + 60_000, payload: new TextEncoder().encode('R$ 10') });
    assert.equal(review.decision, 'review');
    const channel = new SlackChannel({ store: f.store, ledger: f.ledger, profileId: PROFILE, team: TEAM, appId: 'A0TEST', signingSecret: SECRET, now: () => NOW, reviewLink: id => `http://127.0.0.1:1/#tarefa=${encodeURIComponent(id)}` });
    const send = (body: unknown) => {
      const raw = typeof body === 'string' ? body : JSON.stringify(body); const ts = String(NOW / 1000);
      return channel.receive({ 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${raw}`).digest('hex')}` }, raw);
    };
    const button = send({ type: 'block_actions', team: { id: TEAM }, api_app_id: 'A0TEST', user: { id: 'U0OWNER' }, actions: [{ action_id: 'approve', value: review.reviewId }], container: { message_ts: '1' } });
    assert.equal(button.outcome, 'review_required');
    assert.match(button.reply!, /#tarefa=/);
    const typed = send({ type: 'event_callback', team_id: TEAM, api_app_id: 'A0TEST', event_id: 'EvApprove', event: { type: 'message', channel: 'D0OWNER', user: 'U0OWNER', text: `aprovar ${review.reviewId}`, ts: '2' } });
    assert.notEqual(typed.outcome, 'approved');
    await assert.rejects(() => g.dispatch({ version: 1, operationId: 'pay-1', profileId: PROFILE, sessionId: 's', taskId: task.taskId, runId: 'r', adapter: 'bank', action: 'pay', account: 'acct', destination: 'vendor', policyVersion: '1', expiresAt: NOW + 60_000, payload: new TextEncoder().encode('R$ 10') }, () => 'sent'), /approval_required/);
  } finally { g.close(); f.close(); }
});

test('outbound notices go through the gateway: review blocks without a grant, secrets never leave, uncertain sends are not retried', async () => {
  const f = channelFixture();
  const g = gateway(f.dir, f.authority);
  try {
    const task = f.needsInput();
    const sent: string[] = [];
    const sender = new ChannelSender({ gateway: g, ledger: f.ledger, profileId: PROFILE, transport: async (bytes, meta) => { sent.push(`${meta.destination}:${new TextDecoder().decode(bytes)}`); return { thread: 'ts-1' }; } });
    assert.equal((await sender.notify(notice(task.taskId), task)).outcome, 'approval_required');
    assert.deepEqual(sent, []);
    assert.equal((await sender.notify(notice(task.taskId, { operationId: 'leak', text: `token ${CANARY}` }), task)).outcome, 'denied');
    assert.deepEqual(sent, []);

    const open = gateway(f.dir, f.authority, () => 'allow');
    const allowed = new ChannelSender({ gateway: open, ledger: f.ledger, profileId: PROFILE, transport: async (bytes, meta) => { sent.push(`${meta.destination}:${new TextDecoder().decode(bytes)}`); return { thread: 'ts-ask' }; } });
    assert.equal((await allowed.notify(notice(task.taskId, { operationId: 'ask-1' }), task)).outcome, 'sent');
    assert.equal(sent.length, 1);
    assert.equal(f.ledger.thread('slack', TEAM, 'D0OWNER', 'ts-ask')!.inputRevision, task.inputRevision, 'the question is bound to the input it asks for');
    assert.equal((await allowed.notify(notice(task.taskId, { operationId: 'ask-1' }), task)).outcome, 'already_dispatched');
    const failing = new ChannelSender({ gateway: open, ledger: f.ledger, profileId: PROFILE, transport: async () => { throw new Error('socket hang up'); } });
    assert.equal((await failing.notify(notice(task.taskId, { operationId: 'ask-2' }), task)).outcome, 'effect_uncertain');
    assert.equal((await failing.notify(notice(task.taskId, { operationId: 'ask-2' }), task)).outcome, 'already_dispatched', 'no automatic resend of an ambiguous post');
    assert.equal(open.status('ask-2'), 'uncertain');
    open.close();
  } finally { g.close(); f.close(); }
});
