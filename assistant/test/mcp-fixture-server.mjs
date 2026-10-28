// Disposable MCP server over stdio for connector tests. Behaviour comes from env:
// FIXTURE_TOOLS extra filler tools, FIXTURE_PAGE page size, FIXTURE_VARIANT changes a schema,
// FIXTURE_NAME changes serverInfo, FIXTURE_LOG appends every tools/call it receives, FIXTURE_TOKEN is a credential it must never return.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
const pageSize = Number(env.FIXTURE_PAGE || 3);
const tools = [
  { name: 'drive_search', description: 'Search files', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'drive_read', description: 'Read a file', inputSchema: { type: 'object', properties: { fileId: { type: 'string' }, ...(env.FIXTURE_VARIANT === 'schema' ? { revision: { type: 'string' } } : {}) } }, annotations: { readOnlyHint: true } },
  { name: 'drive_update', description: 'Replace a file', inputSchema: { type: 'object', properties: { fileId: { type: 'string' }, content: { type: 'string' } } }, annotations: env.FIXTURE_VARIANT === 'effect' ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true } },
  { name: 'mystery', description: 'No annotations', inputSchema: { type: 'object' } },
  ...Array.from({ length: Number(env.FIXTURE_TOOLS || 0) }, (_, i) => ({ name: `filler_${String(i).padStart(3, '0')}`, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })),
];
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return send({ id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: env.FIXTURE_NAME || 'fixture-drive', version: '1.0.0' } } });
  if (method === 'tools/list') {
    const start = params?.cursor ? Number(Buffer.from(params.cursor, 'base64url').toString()) : 0;
    const end = start + pageSize;
    return send({ id, result: { tools: tools.slice(start, end), ...(end < tools.length ? { nextCursor: Buffer.from(String(end)).toString('base64url') } : {}) } });
  }
  if (method === 'tools/call') {
    if (env.FIXTURE_LOG) appendFileSync(env.FIXTURE_LOG, `${JSON.stringify(params)}\n`);
    if (params.arguments?.query === '__env') return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env).filter(key => /CANARY/u.test(key))) }] } });
    if (!env.FIXTURE_TOKEN) return send({ id, result: { isError: true, content: [{ type: 'text', text: 'unauthenticated' }] } });
    return send({ id, result: { content: [{ type: 'text', text: `${params.name}:${JSON.stringify(params.arguments)}` }] } });
  }
  send({ id, error: { code: -32601, message: 'unknown method' } });
});
