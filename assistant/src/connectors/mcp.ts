import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Gateway, EffectRequest } from '../policy/gateway.ts';
import { boundedInteger } from '../limits.ts';
import { immediate } from '../store/transaction.ts';

export type ToolEffect = 'read' | 'write' | 'unknown';
export type McpTool = { name: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown> };
export type McpPage = { tools: McpTool[]; nextCursor?: string };
/** One MCP server, already authenticated by the host. Credentials never cross this interface. */
export interface McpClient {
  readonly serverId: string;
  /** Fingerprint of the server actually answering (serverInfo, executable or URL digest). */
  identity(): Promise<string>;
  listTools(cursor?: string): Promise<McpPage>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
export type CatalogEntry = { toolId: string; serverId: string; name: string; description: string; schemaHash: string; effect: ToolEffect };
/** Optional consented scope: the call's `argument` must be one of `allowed` (e.g. a Drive file id or a Notion page id). */
export type ResourceScope = { argument: string; allowed: string[] };
export type GrantScope = { agentId: string; accountId: string; toolId: string; expiresAt: number; resources?: ResourceScope };
/** Run context a write needs so the gateway can bind and review it. */
export type WriteContext = { operationId: string; sessionId: string; taskId: string; runId: string; policyVersion: string; expiresAt: number };
export type ToolCall = { agentId: string; accountId: string; toolId: string; args: Record<string, unknown>; write?: WriteContext };
export type ConnectorOptions = { databasePath: string; profileId: string; operatorAuthority: object; gateway: Gateway; maxPages?: number; now?: () => number };

type ToolRow = { tool_id: string; server_id: string; name: string; description: string; schema_hash: string; effect: ToolEffect; identity: string };
type GrantRow = { id: string; schema_hash: string; identity: string; resources: string | null };

const fail = (code: string): never => { throw new Error(code); };
const isText = (value: unknown, max = 256): value is string => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value) ?? null)).digest('hex');
/** MCP annotations are the server's claim; the grant binds consent to that exact claim and schema. */
export function toolEffect(tool: McpTool): ToolEffect {
  const hints = tool.annotations ?? {};
  if (hints.readOnlyHint === true && hints.destructiveHint !== true) return 'read';
  if (hints.readOnlyHint === false || hints.destructiveHint === true) return 'write';
  return 'unknown';
}

/** Catalog of discovered MCP tools and the operator's grants over them. The catalog is never permission. */
export class ConnectorRegistry {
  private db: DatabaseSync;
  private options: ConnectorOptions;
  private now: () => number;
  private maxPages: number;
  constructor(options: ConnectorOptions) {
    if (!options.operatorAuthority || typeof options.operatorAuthority !== 'object' || !isText(options.profileId) || !options.gateway) fail('invalid_options');
    this.options = { ...options };
    this.now = options.now ?? Date.now;
    this.maxPages = boundedInteger(options.maxPages, 50, 1, 1000);
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS connector_tools (profile TEXT NOT NULL, tool_id TEXT NOT NULL, server_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, schema_hash TEXT NOT NULL, effect TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY (profile, tool_id));
      CREATE TABLE IF NOT EXISTS connector_grants (id TEXT PRIMARY KEY, profile TEXT NOT NULL, agent TEXT NOT NULL, account TEXT NOT NULL, tool_id TEXT NOT NULL, schema_hash TEXT NOT NULL, identity TEXT NOT NULL, expires INTEGER NOT NULL, resources TEXT, revoked INTEGER NOT NULL DEFAULT 0);`);
  }

  /** Lists every page, rejects loops and duplicates, then replaces this server's catalog atomically. */
  async discover(client: McpClient): Promise<CatalogEntry[]> {
    if (!isText(client.serverId) || client.serverId.includes('/')) fail('invalid_server');
    const identity = await this.identityOf(client);
    const tools = new Map<string, ToolRow>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= this.maxPages) fail('connector_discovery_unbounded');
      let result: McpPage;
      try { result = await client.listTools(cursor); } catch { return fail('connector_discovery_failed'); }
      if (!result || !Array.isArray(result.tools)) fail('connector_discovery_invalid');
      for (const tool of result.tools) {
        if (!tool || !isText(tool.name, 128) || tool.name.includes('/')) fail('connector_discovery_invalid');
        const toolId = `${client.serverId}/${tool.name}`;
        if (tools.has(toolId)) fail('connector_duplicate_tool');
        const description = typeof tool.description === 'string' ? tool.description.slice(0, 2000) : '';
        tools.set(toolId, { tool_id: toolId, server_id: client.serverId, name: tool.name, description, schema_hash: digest({ inputSchema: tool.inputSchema, annotations: tool.annotations }), effect: toolEffect(tool), identity });
      }
      if (result.nextCursor === undefined || result.nextCursor === '') break;
      if (!isText(result.nextCursor, 4096) || cursors.has(result.nextCursor)) fail('connector_cursor_loop');
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    this.transaction(() => {
      this.db.prepare('DELETE FROM connector_tools WHERE profile = ? AND server_id = ?').run(this.options.profileId, client.serverId);
      const insert = this.db.prepare('INSERT INTO connector_tools VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const row of tools.values()) insert.run(this.options.profileId, row.tool_id, row.server_id, row.name, row.description, row.schema_hash, row.effect, row.identity);
    });
    return [...tools.values()].map(entry);
  }

  /** Stable order by tool id; the cursor is the last id returned. */
  list(options: { cursor?: string; limit?: number } = {}): { items: CatalogEntry[]; nextCursor?: string } {
    const limit = boundedInteger(options.limit, 50, 1, 200);
    const rows = this.db.prepare('SELECT * FROM connector_tools WHERE profile = ? AND tool_id > ? ORDER BY tool_id LIMIT ?').all(this.options.profileId, options.cursor ?? '', limit + 1) as ToolRow[];
    const items = rows.slice(0, limit).map(entry);
    return rows.length > limit ? { items, nextCursor: items.at(-1)!.toolId } : { items };
  }

  grant(scope: GrantScope, authority: object): string {
    this.authorize(authority);
    if (!isText(scope.agentId) || !isText(scope.accountId) || !Number.isSafeInteger(scope.expiresAt) || scope.expiresAt <= this.now()) fail('invalid_grant');
    const resources = scope.resources === undefined ? null : validResources(scope.resources);
    const tool = this.tool(scope.toolId) ?? fail('connector_tool_unknown');
    const id = randomUUID();
    this.db.prepare('INSERT INTO connector_grants (id, profile, agent, account, tool_id, schema_hash, identity, expires, resources) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, this.options.profileId, scope.agentId, scope.accountId, tool.tool_id, tool.schema_hash, tool.identity, scope.expiresAt, resources);
    return id;
  }

  revoke(grantId: string, authority: object): void {
    this.authorize(authority);
    this.db.prepare('UPDATE connector_grants SET revoked = 1 WHERE id = ? AND profile = ?').run(grantId, this.options.profileId);
  }

  /** Every check runs before the tool is called: reads go straight to the server, anything else through the gateway. */
  async call(input: ToolCall, client: McpClient): Promise<unknown> {
    const request = ownedCall(input);
    const live = await this.identityOf(client);
    const tool = this.admit(request, client, live);
    if (tool.effect === 'read') return this.invoke(client, tool.name, request.args);
    const write = request.write ?? fail('connector_write_context_required');
    return this.options.gateway.dispatch(this.effectRequest(request, tool, write), (bytes) => this.invoke(client, tool.name, JSON.parse(Buffer.from(bytes).toString('utf8'))));
  }

  /** Asks the gateway for review of a write; the review carries the exact arguments that dispatch will send. */
  async previewWrite(input: ToolCall & { write: WriteContext }, client: McpClient) {
    const request = ownedCall(input);
    const tool = this.admit(request, client, await this.identityOf(client));
    if (tool.effect === 'read') fail('connector_not_a_write');
    return this.options.gateway.prepare(this.effectRequest(request, tool, request.write ?? fail('connector_write_context_required')));
  }

  close(): void { this.db.close(); }

  private admit(request: ToolCall, client: McpClient, live: string): ToolRow {
    if (!isText(request.agentId) || !isText(request.accountId)) fail('invalid_call');
    const tool = this.tool(request.toolId) ?? fail('connector_tool_unknown');
    if (tool.server_id !== client.serverId || tool.identity !== live) fail('connector_replaced');
    const grants = this.db.prepare('SELECT id, schema_hash, identity, resources FROM connector_grants WHERE profile = ? AND agent = ? AND account = ? AND tool_id = ? AND revoked = 0 AND expires > ?')
      .all(this.options.profileId, request.agentId, request.accountId, tool.tool_id, this.now()) as GrantRow[];
    if (!grants.length) fail('connector_not_granted');
    // The schema hash covers the annotations the effect is derived from, so it also pins the effect the operator consented to.
    const current = grants.filter(grant => grant.schema_hash === tool.schema_hash && grant.identity === tool.identity);
    if (!current.length) fail('connector_revalidation_required');
    if (!current.some(grant => inScope(grant.resources, request.args))) fail('connector_out_of_scope');
    return tool;
  }

  private effectRequest(request: ToolCall, tool: ToolRow, write: WriteContext): EffectRequest {
    return { version: 1, operationId: write.operationId, profileId: this.options.profileId, sessionId: write.sessionId, taskId: write.taskId, runId: write.runId, adapter: 'mcp', action: tool.tool_id, account: request.accountId, destination: `${tool.server_id}#${tool.identity}`, policyVersion: write.policyVersion, expiresAt: write.expiresAt, payload: Buffer.from(JSON.stringify(request.args)) };
  }

  private async invoke(client: McpClient, name: string, args: Record<string, unknown>): Promise<unknown> {
    try { return await client.callTool(name, args); } catch { return fail('connector_call_failed'); }
  }

  private async identityOf(client: McpClient): Promise<string> {
    let identity: unknown;
    try { identity = await client.identity(); } catch { return fail('connector_identity_failed'); }
    return isText(identity, 512) ? identity : fail('connector_identity_failed');
  }

  private tool(toolId: unknown): ToolRow | undefined {
    if (!isText(toolId, 512)) return undefined;
    return this.db.prepare('SELECT * FROM connector_tools WHERE profile = ? AND tool_id = ?').get(this.options.profileId, toolId) as ToolRow | undefined;
  }

  private authorize(authority: object): void { if (authority !== this.options.operatorAuthority) fail('unauthorized'); }

  private transaction(work: () => void): void { immediate(this.db, work); }
}

/** One owned, plain copy of the call: scope checks, review and dispatch all see the same values (no getters, no later mutation). */
function ownedCall(input: ToolCall): ToolCall {
  try {
    const args: unknown = JSON.parse(JSON.stringify(input.args));
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
    const write = input.write === undefined ? undefined : { ...input.write };
    return { agentId: input.agentId, accountId: input.accountId, toolId: input.toolId, args: args as Record<string, unknown>, write };
  } catch { return fail('invalid_call'); }
}

function validResources(scope: ResourceScope): string {
  if (!scope || !isText(scope.argument, 128) || !Array.isArray(scope.allowed) || !scope.allowed.length || scope.allowed.length > 1000 || !scope.allowed.every(item => isText(item, 1024))) return fail('invalid_grant');
  return JSON.stringify({ argument: scope.argument, allowed: [...new Set(scope.allowed)] });
}

function inScope(resources: string | null, args: Record<string, unknown>): boolean {
  if (resources === null) return true;
  const scope = JSON.parse(resources) as ResourceScope;
  const value = Object.hasOwn(args, scope.argument) ? args[scope.argument] : undefined;
  return typeof value === 'string' && scope.allowed.includes(value);
}

function entry(row: ToolRow): CatalogEntry {
  return { toolId: row.tool_id, serverId: row.server_id, name: row.name, description: row.description, schemaHash: row.schema_hash, effect: row.effect };
}
