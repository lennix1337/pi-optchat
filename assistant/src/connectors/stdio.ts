import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { McpClient, McpPage } from './mcp.ts';

export type StdioServer = { serverId: string; command: string; args: readonly string[]; env?: Record<string, string>; cwd?: string; timeoutMs?: number };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Minimal MCP client over newline-delimited JSON-RPC on a child process's stdio (no shell). */
export class StdioMcpClient implements McpClient {
  readonly serverId: string;
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private next = 1;
  private ready: Promise<string>;
  private timeoutMs: number;
  private closed = false;

  constructor(server: StdioServer) {
    this.serverId = server.serverId;
    this.timeoutMs = server.timeoutMs ?? 15000;
    // Only the variables the operator listed reach the server, plus what Windows needs to start a process.
    const base = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    this.child = spawn(server.command, [...server.args], { cwd: server.cwd, env: { ...base, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', line => this.receive(line));
    const failAll = () => { this.closed = true; for (const [id, item] of this.pending) { clearTimeout(item.timer); item.reject(new Error('connector_server_exited')); this.pending.delete(id); } };
    this.child.on('exit', failAll);
    this.child.on('error', failAll);
    this.ready = this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'optchat-assistant', version: '1' } }).then(result => {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const info = (result as { serverInfo?: unknown; protocolVersion?: unknown }) ?? {};
      return createHash('sha256').update(JSON.stringify([server.command, server.args, info.serverInfo ?? null, info.protocolVersion ?? null])).digest('hex');
    });
    this.ready.catch(() => undefined);
  }

  identity(): Promise<string> { return this.ready; }

  async listTools(cursor?: string): Promise<McpPage> {
    await this.ready;
    return await this.request('tools/list', cursor === undefined ? {} : { cursor }) as McpPage;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ready;
    const result = await this.request('tools/call', { name, arguments: args }) as { isError?: boolean };
    if (result?.isError === true) throw new Error('connector_tool_error');
    return result;
  }

  close(): void { this.closed = true; this.child.stdin.end(); this.child.kill(); }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('connector_server_exited'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('connector_timeout')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private receive(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: unknown };
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message?.id !== 'number') return;
    const item = this.pending.get(message.id);
    if (!item) return;
    this.pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error !== undefined) item.reject(new Error('connector_rpc_error'));
    else item.resolve(message.result);
  }
}
