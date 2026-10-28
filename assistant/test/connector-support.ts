import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, type Gateway } from '../src/policy/gateway.ts';
import { ConnectorRegistry } from '../src/connectors/mcp.ts';
import { StdioMcpClient } from '../src/connectors/stdio.ts';

export const TOKEN = 'fixture-token-canary-7f3a';
const server = fileURLToPath(new URL('./mcp-fixture-server.mjs', import.meta.url));

export type Rig = {
  dir: string; authority: object; gateway: Gateway; registry: ConnectorRegistry; clock: { now: number };
  open: (profileId?: string) => ConnectorRegistry;
  client: (env?: Record<string, string>) => StdioMcpClient;
  calls: () => unknown[];
};

export async function withConnectors(fn: (rig: Rig) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'connectors-'));
  const authority = {};
  const clock = { now: Date.now() };
  const log = join(dir, 'calls.log');
  const databasePath = join(dir, 'assistant.db');
  const gateway = createGateway({ databasePath, profileId: 'p', operatorAuthority: authority, now: () => clock.now, policy: metadata => metadata.adapter === 'mcp' ? 'review' : 'deny', inspect: () => ({ decision: 'allow', reasons: [] }) });
  const registries: ConnectorRegistry[] = [];
  const clients: StdioMcpClient[] = [];
  const open = (profileId = 'p') => { const r = new ConnectorRegistry({ databasePath, profileId, operatorAuthority: authority, gateway, now: () => clock.now }); registries.push(r); return r; };
  const client = (env: Record<string, string> = {}) => { const c = new StdioMcpClient({ serverId: 'drive', command: process.execPath, args: [server], env: { FIXTURE_TOKEN: TOKEN, FIXTURE_LOG: log, ...env } }); clients.push(c); return c; };
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    await fn({ dir, authority, gateway, registry: open(), clock, open, client, calls });
  } finally {
    for (const c of clients) c.close();
    for (const r of registries) r.close();
    gateway.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export const hour = 3600_000;
