import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectorRegistry, toolEffect, type McpClient, type McpPage } from '../src/connectors/mcp.ts';
import { withConnectors, TOKEN } from './connector-support.ts';

test('discovery walks every page and listing pages through the catalog without losing or repeating a tool', () => withConnectors(async ({ dir, registry, client }) => {
  const discovered = await registry.discover(client({ FIXTURE_TOOLS: '200', FIXTURE_PAGE: '7' }));
  assert.equal(discovered.length, 204);
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = registry.list({ cursor, limit: 50 });
    assert.ok(page.items.length <= 50);
    seen.push(...page.items.map(item => item.toolId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 204);
  assert.equal(new Set(seen).size, 204);
  assert.deepEqual(seen, [...seen].sort());
  assert.deepEqual(new Set(seen), new Set(discovered.map(item => item.toolId)));
  const effects = Object.fromEntries(discovered.filter(item => !item.name.startsWith('filler')).map(item => [item.name, item.effect]));
  assert.deepEqual(effects, { drive_search: 'read', drive_read: 'read', drive_update: 'write', mystery: 'unknown' });
  assert.equal(toolEffect({ name: 'x', annotations: { readOnlyHint: true, destructiveHint: true } }), 'write', 'a destructive hint outweighs a read-only one');

  const again = await registry.discover(client({ FIXTURE_TOOLS: '200', FIXTURE_PAGE: '13' }));
  assert.deepEqual(again.map(item => [item.toolId, item.schemaHash]).sort(), discovered.map(item => [item.toolId, item.schemaHash]).sort(), 'ids and schema hashes are stable across page sizes and processes');
  for (const file of readdirSync(dir).filter(name => name.startsWith('assistant.db'))) assert.ok(!readFileSync(join(dir, file)).includes(TOKEN), `${file} holds no credential`);
  assert.ok(!JSON.stringify(registry.list({ limit: 200 })).includes(TOKEN));
}));

function fake(pages: McpPage[], serverId = 'fake'): McpClient {
  return { serverId, identity: async () => 'fake-identity', listTools: async cursor => pages[cursor === undefined ? 0 : Number(cursor)] ?? { tools: [] }, callTool: async () => assert.fail('never called') };
}

test('a cursor loop, an unbounded listing, a duplicate or a malformed tool leaves the previous catalog intact', () => withConnectors(async ({ dir, gateway, authority, registry, client }) => {
  const good = { tools: [{ name: 'a', annotations: { readOnlyHint: true } }] };
  await registry.discover(fake([good]));
  const loop = fake([{ tools: [{ name: 'b' }], nextCursor: '1' }, { tools: [{ name: 'c' }], nextCursor: '1' }]);
  await assert.rejects(registry.discover(loop), /connector_cursor_loop/);
  await assert.rejects(registry.discover(fake([{ tools: [{ name: 'a' }], nextCursor: '1' }, { tools: [{ name: 'a' }] }])), /connector_duplicate_tool/);
  await assert.rejects(registry.discover(fake([{ tools: [{ name: 'x/y' }] }])), /connector_discovery_invalid/);
  await assert.rejects(registry.discover(fake([{ tools: 'nope' } as never])), /connector_discovery_invalid/);
  await assert.rejects(registry.discover(fake([good], 'bad/server')), /invalid_server/);
  const bounded = new ConnectorRegistry({ databasePath: join(dir, 'assistant.db'), profileId: 'p', operatorAuthority: authority, gateway, maxPages: 2 });
  try { await assert.rejects(bounded.discover(client({ FIXTURE_TOOLS: '20', FIXTURE_PAGE: '3' })), /connector_discovery_unbounded/); } finally { bounded.close(); }
  assert.deepEqual(registry.list().items.map(item => item.toolId), ['fake/a']);
}));
