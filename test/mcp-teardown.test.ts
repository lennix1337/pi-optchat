import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

// The MCP extension reads mcp.json from Pi's agent dir: never the user's real one.
const agentDir = process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-teardown-agent-'));
const server = resolve(import.meta.dirname, 'fixtures', 'stubborn-mcp.mjs');

async function until(condition: () => boolean, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 20)); }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const pids = (log: string) => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => ({ role: line.split(' ')[0], pid: Number(line.split(' ')[1]) })) : [];

/** The server as the user's config starts it: on Windows through a `.cmd` shim, as `npx` is, so a process tree sits between Pi and the server. */
function configure(dir: string, log: string) {
  let command = process.execPath, args = [server, log];
  if (process.platform === 'win32') {
    command = join(dir, 'stubborn.cmd'); args = [];
    writeFileSync(command, `@"${process.execPath}" "${server}" "${log}"\r\n`);
  }
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { stubborn: { command, args, exposure: 'direct' } } }));
}

/** Children whose model answers once `ready` says the server (and its child) are up, or at once when `ready` is absent. */
async function setup(dir: string, ready?: () => boolean) {
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const finish = () => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); };
      const poll = () => ready && !ready() && !options?.signal?.aborted ? setTimeout(poll, 20) : finish();
      queueMicrotask(poll);
      return stream;
    },
  });
  const warnings: string[] = [];
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, text => warnings.push(text), dir, { settings: () => ({ subagentLevels: 1, maxAgents: 8 }), builtins: () => ['mcp'], createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  return { children, memory, warnings };
}

/** Every process the server started is gone: the server and the child it spawned. */
const gone = (log: string) => pids(log).every(({ pid }) => !alive(pid));
/** What a failing test would leave behind: the processes this test started, which would also lock the temp dir they run in. */
const reap = (log: string) => { for (const { pid } of pids(log)) { try { process.kill(pid); } catch { /* already gone */ } } };

test('a finished worker leaves no MCP server process running, including a server that ignores stdin closing and its own child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-teardown-'));
  const log = join(dir, 'servers.log');
  configure(dir, log);
  const { children, memory, warnings } = await setup(dir, () => pids(log).some(p => p.role === 'child'));
  try {
    await children.spawn([{ task: 'work' }], dir);
    await until(() => !children.active);
    const started = pids(log);
    assert.deepEqual(started.map(p => p.role), ['start', 'child'], 'the worker started the MCP server, which started its child');
    await until(() => gone(log), 10000).catch(() => assert.fail(`still running after the worker ended: ${started.filter(p => alive(p.pid)).map(p => `${p.role} ${p.pid}`)}`));
    assert.deepEqual(warnings, []);
  } finally { reap(log); await children.close(); await memory.close(); removeDir(dir); rmSync(join(agentDir, 'mcp.json'), { force: true }); }
});

test('a worker stopped while its MCP server is up leaves no server process running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-teardown-stop-'));
  const log = join(dir, 'servers.log');
  configure(dir, log);
  const { children, memory } = await setup(dir, () => false); // the model holds the worker in its first request until the stop aborts it
  try {
    const [id] = await children.spawn([{ task: 'work' }], dir);
    await until(() => pids(log).some(p => p.role === 'child'));
    await children.stop(id);
    await until(() => !children.active);
    await until(() => gone(log), 10000).catch(() => assert.fail(`still running after the worker was stopped: ${pids(log).filter(p => alive(p.pid)).map(p => `${p.role} ${p.pid}`)}`));
  } finally { reap(log); await children.close(); await memory.close(); removeDir(dir); rmSync(join(agentDir, 'mcp.json'), { force: true }); }
});

test('a worker that ends while its MCP server is still starting leaves no server process running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-teardown-early-'));
  const log = join(dir, 'servers.log');
  configure(dir, log);
  const { children, memory } = await setup(dir); // answers at once, before the server can have connected
  try {
    await children.spawn([{ task: 'work' }], dir);
    await until(() => !children.active);
    await new Promise(r => setTimeout(r, 3000)); // a server started late would be in the log by now
    assert.ok(gone(log), `still running after the worker ended: ${pids(log).filter(p => alive(p.pid)).map(p => `${p.role} ${p.pid}`)}`);
  } finally { reap(log); await children.close(); await memory.close(); removeDir(dir); rmSync(join(agentDir, 'mcp.json'), { force: true }); }
});
