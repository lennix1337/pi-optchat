import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withConnectors, hour } from './connector-support.ts';

const read = { agentId: 'agent-a', accountId: 'acct-x', toolId: 'drive/drive_read', args: { fileId: 'f1' } };
const scope = (expiresAt: number) => ({ agentId: 'agent-a', accountId: 'acct-x', toolId: 'drive/drive_read', expiresAt });

test('a revoked or expired grant is refused before dispatch, also in a fresh registry', () => withConnectors(async ({ registry, authority, clock, open, client, calls }) => {
  const drive = client();
  await registry.discover(drive);
  const id = registry.grant(scope(clock.now + hour), authority);
  await registry.call(read, drive);
  assert.throws(() => registry.revoke(id, {}), /unauthorized/);
  registry.revoke(id, authority);
  await assert.rejects(registry.call(read, drive), /connector_not_granted/);
  await assert.rejects(open().call(read, drive), /connector_not_granted/, 'revocation is durable');
  registry.grant(scope(clock.now + 1000), authority);
  await registry.call(read, drive);
  clock.now += 1001;
  await assert.rejects(registry.call(read, drive), /connector_not_granted/);
  assert.equal(calls().length, 2);
}));

test('a replaced server is refused before dispatch, and its grant needs revalidation after rediscovery', () => withConnectors(async ({ registry, authority, clock, client, calls }) => {
  await registry.discover(client());
  registry.grant(scope(clock.now + hour), authority);
  const impostor = client({ FIXTURE_NAME: 'impostor-drive' });
  await assert.rejects(registry.call(read, impostor), /connector_replaced/, 'same server id, different server answering');
  await registry.discover(impostor);
  await assert.rejects(registry.call(read, impostor), /connector_revalidation_required/);
  registry.grant(scope(clock.now + hour), authority);
  await registry.call(read, impostor);
  assert.equal(calls().length, 1);
}));

test('a changed schema or a write that now claims to be read-only needs a new grant', () => withConnectors(async ({ registry, authority, clock, client, calls }) => {
  await registry.discover(client());
  registry.grant(scope(clock.now + hour), authority);
  registry.grant({ ...scope(clock.now + hour), toolId: 'drive/drive_update' }, authority);
  const changed = client({ FIXTURE_VARIANT: 'schema' });
  await registry.discover(changed);
  await assert.rejects(registry.call(read, changed), /connector_revalidation_required/);

  const relabelled = client({ FIXTURE_VARIANT: 'effect' });
  await registry.discover(relabelled);
  assert.equal(registry.list().items.find(item => item.name === 'drive_update')!.effect, 'read');
  await assert.rejects(registry.call({ ...read, toolId: 'drive/drive_update', args: { fileId: 'f1', content: 'x' } }, relabelled), /connector_revalidation_required/, 'the old write grant cannot become a direct read');
  await registry.call(read, relabelled);
  assert.deepEqual(calls().map(c => (c as { name: string }).name), ['drive_read'], 'drive_read is back to the granted schema; only it reached the server');
}));

test('a tool error is a failure, and the server sees no host variable it was not given', () => withConnectors(async ({ registry, authority, clock, client }) => {
  process.env.HOST_SECRET_CANARY = 'host-only';
  try {
    const drive = client();
    await registry.discover(drive);
    registry.grant({ ...scope(clock.now + hour), toolId: 'drive/drive_search' }, authority);
    const probe = await registry.call({ ...read, toolId: 'drive/drive_search', args: { query: '__env' } }, drive) as { content: { text: string }[] };
    assert.deepEqual(JSON.parse(probe.content[0].text), []);
    const unauthenticated = client({ FIXTURE_TOKEN: '' });
    await assert.rejects(registry.call({ ...read, toolId: 'drive/drive_search', args: { query: 'q' } }, unauthenticated), /connector_call_failed/);
  } finally { delete process.env.HOST_SECRET_CANARY; }
}));

test('a tool that disappears from the server is no longer callable', () => withConnectors(async ({ registry, authority, clock, client }) => {
  await registry.discover(client());
  registry.grant(scope(clock.now + hour), authority);
  const listed = await registry.discover({ serverId: 'drive', identity: () => client().identity(), listTools: async () => ({ tools: [] }), callTool: async () => assert.fail('never called') });
  assert.equal(listed.length, 0);
  await assert.rejects(registry.call(read, client()), /connector_tool_unknown/);
}));
