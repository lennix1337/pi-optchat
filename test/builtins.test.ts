import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { builtinExtensions, Children, loadedBuiltins } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { removeDir } from './support.ts';


const nested = () => ({ subagentLevels: 3, maxAgents: 8 });


const agentDir = process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-builtins-agent-'));
const server = resolve(import.meta.dirname, 'fixtures', 'fake-mcp.mjs');
const ALL = ['mcp', 'codemode', 'tool-search'];

async function until(condition: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}


const exited = (log: string) => readFileSync(log, 'utf8').trim().split('\n').every(line => {
  try { process.kill(Number(line.split(' ')[1]), 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
});


async function mainBuiltins(cwd: string, settings: object, extra: ((pi: ExtensionAPI) => void)[] = []) {
  let api: ExtensionAPI | undefined;
  const settingsManager = SettingsManager.inMemory(settings);
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager,
    extensionFactories: [...builtinExtensions(ALL), ...extra, pi => { api = pi; }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory() });
  try { return [...loadedBuiltins(api!)].sort(); } finally { session.dispose(); }
}

test('the main session reports which built-in extensions it loaded, so settings and replacements carry over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-builtins-main-'));
  try {
    assert.deepEqual(await mainBuiltins(dir, {}), ['codemode', 'mcp', 'tool-search']);
    assert.deepEqual(await mainBuiltins(dir, { extensions: ['-builtin:mcp'] }), ['codemode', 'tool-search'], 'a built-in switched off in settings stays off');
    assert.deepEqual(await mainBuiltins(dir, {}, [pi => pi.registerCommand('mcp', { description: 'other MCP', handler: async () => {} })]), ['codemode', 'tool-search'],
      'a third-party extension that registers /mcp replaces the built-in MCP extension');
  } finally { removeDir(dir); }
});

test('subagents at every depth get the main session\'s built-in extensions and can call MCP tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-builtins-'));
  const log = join(dir, 'servers.log');
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server, log], exposure: 'direct' } } }));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const reports: string[] = [], warnings: string[] = [], seen = new Map<string, string[]>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });

  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const task = textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
      seen.set(task, getCurrentTools(context.messages).map(t => t.name));
      const last = context.messages.at(-1), first = !context.messages.some(m => m.role === 'assistant');
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `${task}: ${textContent(last && 'content' in last ? last.content : '')}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      if (first) {
        message.content = [task === 'root' ? { type: 'toolCall', id: 'spawn-1', name: 'spawn', arguments: { tasks: [{ task: 'nested' }] } }
          : { type: 'toolCall', id: `echo-${task}`, name: 'mcp__fake__echo', arguments: { text: task } }];
        message.stopReason = 'toolUse';
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const spawnChildren = (builtins: string[]) => new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(text); }, text => warnings.push(text), dir, { settings: nested, builtins: () => builtins, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  const servers = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  try {
    const children = spawnChildren(await mainBuiltins(dir, {}));
    const [root] = await children.spawn([{ task: 'root' }], dir);
    const registered = children.live(root)?.session.getAllTools().map(t => t.name) ?? [];
    assert.ok(registered.includes('codemode') && registered.includes('tool_search'), 'codemode and tool_search, which reach MCP servers that are not direct, are registered');
    await until(() => !children.active);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /root: .*nested: echo:nested/s, 'the nested subagent called the MCP tool and its report reached the root');
    for (const task of ['root', 'nested']) assert.ok(seen.get(task)?.includes('mcp__fake__echo'), `${task} sees the MCP tool`);

    await until(() => servers().length === 4);
    assert.deepEqual(servers().map(line => line.split(' ')[0]).sort(), ['exit', 'exit', 'start', 'start']);
    await until(() => exited(log));
    await children.close();


    reports.length = 0; seen.clear(); rmSync(log, { force: true });
    const off = spawnChildren(await mainBuiltins(dir, { extensions: ['-builtin:mcp'] }));
    await off.spawn([{ task: 'offline' }], dir);
    await until(() => !off.active);
    assert.ok(!seen.get('offline')?.includes('mcp__fake__echo'));
    assert.match(reports[0], /offline: .*not found/i);
    assert.deepEqual(servers(), [], 'no MCP server process starts');
    await off.close();
    assert.deepEqual(warnings, []);
  } finally { await memory.close(); removeDir(dir); rmSync(join(agentDir, 'mcp.json'), { force: true }); }
});

test('a batch that fails mid-launch closes the MCP connections of the children it rolls back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-builtins-rollback-'));
  const log = join(dir, 'servers.log');
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server, log], exposure: 'direct' } } }));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple() { throw new Error('rolled-back children never run'); },
  });
  let created = 0;
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, dir, { settings: nested, builtins: () => ALL, createSession: async options => {
      if (++created === 2) {

        await until(() => existsSync(log));
        throw new Error('session store unavailable');
      }
      return createAgentSession({ ...options, modelRuntime: runtime });
    } });
  try {
    await assert.rejects(children.spawn([{ task: 'one' }, { task: 'two' }], dir), /session store unavailable/);
    await until(() => readFileSync(log, 'utf8').includes('exit'));
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => line.split(' ')[0]), ['start', 'exit']);
    await until(() => exited(log));
  } finally { await children.close(); await memory.close(); removeDir(dir); rmSync(join(agentDir, 'mcp.json'), { force: true }); }
});

test('a child whose extensions fail to start still closes its MCP connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-builtins-bind-'));
  const log = join(dir, 'servers.log');
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server, log], exposure: 'direct' } } }));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple() { throw new Error('the child never runs'); },
  });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, dir, { settings: nested, builtins: () => ALL, createSession: async options => {
      const made = await createAgentSession({ ...options, modelRuntime: runtime }), bind = made.session.bindExtensions.bind(made.session);

      made.session.bindExtensions = async bindings => { await bind(bindings); await until(() => existsSync(log)); throw new Error('binding failed'); };
      return made;
    } });
  try {
    await assert.rejects(children.spawn([{ task: 'one' }], dir), /binding failed/);
    await until(() => readFileSync(log, 'utf8').includes('exit'));
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => line.split(' ')[0]), ['start', 'exit']);
    await until(() => exited(log));
    assert.equal(children.active, false, 'the failed child holds no agent slot');
  } finally { await children.close(); await memory.close(); removeDir(dir); rmSync(join(agentDir, 'mcp.json'), { force: true }); }
});

test('plan and mechanical workers skip external MCP servers unless the contract sets mcp: true, preserving WORKER_TOOLS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-fast-worker-'));
  const log = join(dir, 'servers.log');
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server, log], exposure: 'direct' } } }));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const seen = new Map<string, string[]>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const task = textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
      seen.set(task, getCurrentTools(context.messages).map(t => t.name));
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const contract = (label: string) => `Goal: ${label}\nAcceptance: ok\nEvidence: ok\nAuthority: read-only`;
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, dir, { settings: nested, builtins: () => ALL, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  const servers = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  try {
    const planTask = contract('plan fast'), mechTask = contract('mechanical fast');
    await children.spawn([{ task: planTask, kind: 'plan' }, { task: mechTask, kind: 'mechanical' }], dir);
    await until(() => !children.active);
    assert.deepEqual(servers(), [], 'plan and mechanical workers start zero external MCP servers');
    assert.ok(!seen.get(planTask)?.includes('mcp__fake__echo'), 'plan has no MCP tools');
    assert.ok(seen.get(planTask)?.includes('read') && seen.get(planTask)?.includes('codemode'), 'plan keeps WORKER_TOOLS.plan');
    assert.ok(!seen.get(mechTask)?.includes('mcp__fake__echo') && !seen.get(mechTask)?.includes('zoom'), 'mechanical keeps WORKER_TOOLS.mechanical');
    assert.ok(!seen.get(planTask)?.includes('spawn') && !seen.get(mechTask)?.includes('spawn'), 'isOptchat boundary preserved');


    const optOutTask = contract('plan with mcp');
    const [optOutId] = await children.spawn([{ task: optOutTask, kind: 'plan', mcp: true }], dir);
    await until(() => !children.active);
    assert.ok(seen.get(optOutTask)?.includes('codemode'), 'mcp: true preserves WORKER_TOOLS.plan');
    await until(() => servers().length === 2);
    assert.deepEqual(servers().map(line => line.split(' ')[0]).sort(), ['exit', 'start'], 'mcp: true starts the external MCP server');
    await until(() => exited(log));

    await children.tell(optOutId, 'follow up');
    await until(() => !children.active);
    await until(() => servers().length === 4);
    assert.deepEqual(servers().map(line => line.split(' ')[0]).sort(), ['exit', 'exit', 'start', 'start']);
    await until(() => exited(log));
  } finally { await children.close(); await memory.close(); removeDir(dir); rmSync(join(agentDir, 'mcp.json'), { force: true }); }
});
