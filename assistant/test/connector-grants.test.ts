import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withConnectors, hour, TOKEN } from './connector-support.ts';

const call = (toolId: string, args: Record<string, unknown> = {}, who: { agentId?: string; accountId?: string } = {}) => ({ agentId: who.agentId ?? 'agent-a', accountId: who.accountId ?? 'acct-x', toolId, args });

test('the catalog is not permission: a granted read works only for its profile, agent, account and tool', () => withConnectors(async ({ registry, authority, clock, open, client, calls }) => {
  const drive = client();
  await registry.discover(drive);
  await assert.rejects(registry.call(call('drive/drive_search', { query: 'q' }), drive), /connector_not_granted/);
  assert.equal(calls().length, 0, 'a catalogued but ungranted tool never reaches the server');

  assert.throws(() => registry.grant({ agentId: 'agent-a', accountId: 'acct-x', toolId: 'drive/drive_search', expiresAt: clock.now + hour }, { other: true }), /unauthorized/);
  registry.grant({ agentId: 'agent-a', accountId: 'acct-x', toolId: 'drive/drive_search', expiresAt: clock.now + hour }, authority);
  const result = await registry.call(call('drive/drive_search', { query: 'budget' }), drive) as { content: { text: string }[] };
  assert.equal(result.content[0].text, 'drive_search:{"query":"budget"}');

  await assert.rejects(registry.call(call('drive/drive_search', {}, { agentId: 'agent-b' }), drive), /connector_not_granted/);
  await assert.rejects(registry.call(call('drive/drive_search', {}, { accountId: 'acct-y' }), drive), /connector_not_granted/);
  await assert.rejects(registry.call(call('drive/drive_read', { fileId: 'f' }), drive), /connector_not_granted/);
  await assert.rejects(open('q').call(call('drive/drive_search'), drive), /connector_tool_unknown/, 'another profile sees neither the catalog nor the grant');
  assert.equal(calls().length, 1);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
}));

test('a write is reviewed with its exact arguments and dispatched once through the gateway', () => withConnectors(async ({ registry, authority, gateway, clock, client, calls }) => {
  const drive = client();
  await registry.discover(drive);
  for (const tool of ['drive/drive_update', 'drive/mystery']) registry.grant({ agentId: 'agent-a', accountId: 'acct-x', toolId: tool, expiresAt: clock.now + hour }, authority);
  const write = { operationId: 'op-1', sessionId: 's', taskId: 't', runId: 'r', policyVersion: 'v1', expiresAt: clock.now + hour };
  const args = { fileId: 'f1', content: 'new text' };

  await assert.rejects(registry.call(call('drive/drive_update', args), drive), /connector_write_context_required/);
  await assert.rejects(registry.call({ ...call('drive/drive_update', args), write }, drive), /approval_required/);
  await assert.rejects(registry.call({ ...call('drive/mystery', {}), write: { ...write, operationId: 'op-m' } }, drive), /approval_required/, 'a tool of unknown effect is treated as a write');
  assert.equal(calls().length, 0);

  const review = await registry.previewWrite({ ...call('drive/drive_update', args), write }, drive);
  assert.equal(review.decision, 'review');
  if (review.decision !== 'review') return;
  assert.deepEqual(JSON.parse(Buffer.from(review.payload).toString()), args, 'the reviewer sees the exact arguments');
  assert.equal(review.metadata.action, 'drive/drive_update');
  assert.equal(review.metadata.account, 'acct-x');
  gateway.decide(review.reviewId, 'approve', authority);

  await assert.rejects(registry.call({ ...call('drive/drive_update', { ...args, content: 'other' }), write }, drive), /approval_required/, 'changed arguments are not approved');
  await registry.call({ ...call('drive/drive_update', args), write }, drive);
  await assert.rejects(registry.call({ ...call('drive/drive_update', args), write }, drive), /operation_already_dispatched/);
  assert.deepEqual(calls(), [{ name: 'drive_update', arguments: args }]);
  assert.equal(gateway.status('op-1'), 'response_recorded');
}));

test('a resource-scoped read reaches only the consented files, and a getter cannot swap the file after the check', () => withConnectors(async ({ registry, authority, clock, client, calls }) => {
  const drive = client();
  await registry.discover(drive);
  assert.throws(() => registry.grant({ agentId: 'agent-a', accountId: 'acct-x', toolId: 'drive/drive_read', expiresAt: clock.now + hour, resources: { argument: 'fileId', allowed: [] } }, authority), /invalid_grant/);
  registry.grant({ agentId: 'agent-a', accountId: 'acct-x', toolId: 'drive/drive_read', expiresAt: clock.now + hour, resources: { argument: 'fileId', allowed: ['shared-1', 'shared-2'] } }, authority);
  await registry.call(call('drive/drive_read', { fileId: 'shared-2' }), drive);
  await assert.rejects(registry.call(call('drive/drive_read', { fileId: 'private-9' }), drive), /connector_out_of_scope/);
  await assert.rejects(registry.call(call('drive/drive_read', {}), drive), /connector_out_of_scope/);
  await assert.rejects(registry.call(call('drive/drive_read', { fileId: ['shared-1'] }), drive), /connector_out_of_scope/);
  let reads = 0;
  const swapping = { get fileId() { return reads++ === 0 ? 'shared-1' : 'private-9'; } };
  await registry.call(call('drive/drive_read', swapping as never), drive);
  assert.deepEqual(calls().map(c => (c as { arguments: unknown }).arguments), [{ fileId: 'shared-2' }, { fileId: 'shared-1' }]);
}));

test('previewWrite refuses a read tool and malformed calls are refused before the server', () => withConnectors(async ({ registry, authority, clock, client, calls }) => {
  const drive = client();
  await registry.discover(drive);
  registry.grant({ agentId: 'agent-a', accountId: 'acct-x', toolId: 'drive/drive_search', expiresAt: clock.now + hour }, authority);
  const write = { operationId: 'op', sessionId: 's', taskId: 't', runId: 'r', policyVersion: 'v1', expiresAt: clock.now + hour };
  await assert.rejects(registry.previewWrite({ ...call('drive/drive_search'), write }, drive), /connector_not_a_write/);
  for (const bad of [{ ...call('drive/drive_search'), args: [] }, { ...call('drive/drive_search'), agentId: ' a' }, { ...call('drive/drive_search'), toolId: 'drive/../x' }]) await assert.rejects(registry.call(bad as never, drive), /invalid_call|connector_tool_unknown/);
  assert.throws(() => registry.grant({ agentId: 'agent-a', accountId: 'acct-x', toolId: 'drive/nope', expiresAt: clock.now + hour }, authority), /connector_tool_unknown/);
  assert.throws(() => registry.grant({ agentId: 'agent-a', accountId: 'acct-x', toolId: 'drive/drive_search', expiresAt: clock.now }, authority), /invalid_grant/);
  assert.equal(calls().length, 0);
}));
