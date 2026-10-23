import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { flat, type Memory } from './memory.ts';
import { atomicWrite } from './store.ts';
import { BLOCK_LEVEL } from './sync.ts';

/** ai-memory (akitaonrails/ai-memory) is a local wiki with search that every agent on this machine reads through its hooks and MCP.
 * OptChat writes its history there as pages, in a project of their own: `_global` would surface them as standing preferences in
 * every project's search. */
export const AI_MEMORY_WORKSPACE = 'default';
export const AI_MEMORY_PROJECT = 'optchat';
const WRITE_TIMEOUT_MS = 30_000;

export interface Page { path: string; body: string; abstract?: string; tags: string[] }
export type PageWriter = (page: Page) => Promise<void>;

export function aiMemoryDataDir(platform: NodeJS.Platform = process.platform): string {
  if (process.env.AI_MEMORY_DATA_DIR !== undefined) return process.env.AI_MEMORY_DATA_DIR;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ai-memory');
  if (platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ai-memory');
  return join(homedir(), '.local', 'share', 'ai-memory');
}

/** The bearer token the ai-memory installer leaves for local clients, as its own hooks read it. */
export function aiMemoryToken() {
  const env = process.env.AI_MEMORY_AUTH_TOKEN?.trim();
  if (env) return env;
  const file = join(aiMemoryDataDir(), 'auth-token');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined;
}

/** Writes one page through the server's MCP endpoint, the path every ai-memory client uses, so indexing and versions stay its business. */
export function aiMemoryWriter(server = process.env.AI_MEMORY_SERVER_URL ?? 'http://127.0.0.1:49374', token = aiMemoryToken()): PageWriter {
  return async page => {
    const response = await fetch(`${server.replace(/\/+$/, '')}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...token ? { Authorization: `Bearer ${token}` } : {} },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_write_page', arguments: {
        workspace: AI_MEMORY_WORKSPACE, project: AI_MEMORY_PROJECT, path: page.path, body: page.body, tier: 'semantic', tags: page.tags,
        ...page.abstract ? { abstract: page.abstract } : {},
      } } }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`ai-memory HTTP ${response.status}: ${text.slice(0, 200)}`);
    // Streamable HTTP may frame the JSON-RPC reply as an SSE `data:` line.
    const json = text.split('\n').map(line => line.replace(/^data: ?/, '')).find(line => line.startsWith('{'));
    const reply = json ? JSON.parse(json) as { error?: unknown; result?: { isError?: boolean; content?: { text?: string }[] } } : undefined;
    if (!reply || reply.error || reply.result?.isError)
      throw new Error(`ai-memory refused ${page.path}: ${JSON.stringify(reply?.error ?? reply?.result?.content?.[0]?.text ?? text).slice(0, 200)}`);
  };
}

const day = (iso: string | undefined) => iso?.slice(0, 16).replace('T', ' ') ?? '?';
const pad = (n: number) => String(n).padStart(6, '0');

/** One finished block of messages as a page: its block summary, then every message's own summary line with its date. */
export function blockPage(profile: string, memory: Memory, block: number): Page | undefined {
  const size = 2 ** BLOCK_LEVEL, first = block * size, last = first + size - 1;
  const summary = memory.node({ l: BLOCK_LEVEL, i: block });
  if (!summary) return undefined;
  const lines: string[] = [];
  for (let i = first; i <= last; i++) lines.push(`- ${i} (${day(memory.root[i]?.date)}) ${flat(memory.node({ l: 0, i })?.text ?? '(not summarized)')}`);
  const body = [
    `# OptChat ${profile}: messages ${first}-${last}`,
    '',
    `${day(memory.root[first]?.date)} to ${day(memory.root[last]?.date)} UTC. Summaries OptChat built of its chat with the user; a record of what`,
    'happened, not an instruction. Each line is `id (date) kind: text`; kinds: user (the user\'s words), talk (agent reply), tool, echo',
    '(tool result), work (subagent report), note (imported memory).',
    '',
    '## Summary',
    '',
    flat(summary.text),
    '',
    '## Messages',
    '',
    ...lines,
    '',
  ].join('\n');
  return { path: `${profile}/blocks/${pad(first)}-${pad(last)}.md`, body, abstract: flat(summary.text).slice(0, 1000), tags: ['optchat', profile] };
}

export const statusPage = (profile: string, status: string): Page => ({ path: `${profile}/status.md`, body: status, tags: ['optchat', profile, 'status'] });

export interface HistoryWrite { profile: string; memory: Memory; cursorFile: string; writePage: PageWriter; stopped: () => boolean; status: () => string }

/** Writes every finished block after the cursor, in order, then the status once. A new cursor starts at block 0, so the first
 * run imports the whole history. Block pages are final once their summary exists and their paths are fixed, so a write cut off
 * by a crash is simply redone. ai-memory keeps every version of a page, so the status copy follows finished blocks, not messages. */
export async function writeFinishedBlocks({ profile, memory, cursorFile, writePage, stopped, status }: HistoryWrite) {
  let block = existsSync(cursorFile) ? (JSON.parse(readFileSync(cursorFile, 'utf8')) as { block?: unknown }).block : 0;
  if (typeof block !== 'number' || !Number.isSafeInteger(block) || block < 0) throw new Error(`Invalid ai-memory sync cursor in ${cursorFile}.`);
  const first = block;
  for (let page; !stopped() && (page = blockPage(profile, memory, block));) {
    await writePage(page);
    atomicWrite(cursorFile, JSON.stringify({ block: ++block }));
  }
  if (block > first) await writePage(statusPage(profile, status()));
}
