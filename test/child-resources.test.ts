import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime, createAgentSession } from '@earendil-works/pi-coding-agent';
import { childToolSchemas } from '../src/child-resources.ts';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { removeDir } from './support.ts';

test('child schema resources are immutable shared definitions', () => {
  const frozen = (value: unknown): boolean => !value || typeof value !== 'object' || (Object.isFrozen(value) && Reflect.ownKeys(value).every(key => frozen(Reflect.get(value, key))));
  assert.ok(frozen(childToolSchemas), 'the whole schema graph is frozen');
  assert.strictEqual(childToolSchemas.spawn, childToolSchemas.spawn);
  assert.strictEqual(childToolSchemas.tell, childToolSchemas.tell);
  assert.strictEqual(childToolSchemas.parent, childToolSchemas.parent);
});

test('children get fresh closures and current delegation settings while reusing only frozen schemas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-child-resources-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'optchat-child-resources-agent-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple() { throw new Error('createSession must stop before any model request'); },
  });
  type SessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
  type ChildTools = NonNullable<SessionOptions['customTools']>;
  const captures: ChildTools[] = [];
  let settings = { subagentLevels: 2, maxAgents: 8 };
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, dir, {
      settings: () => settings,
      createSession: async options => {
        if (!options) throw new Error('Expected child session options');
        captures.push(options.customTools ?? []);
        throw new Error('intentional stop after capturing child tools');
      },
    });
  const captureTools = async () => assert.rejects(children.spawn([{ task: 'capture only' }], dir), /intentional stop after capturing child tools/);
  const named = (tools: ChildTools, name: string) => {
    const tool = tools.find(candidate => candidate.name === name);
    assert.ok(tool, `expected ${name} tool`);
    return tool;
  };
  try {
    await captureTools();
    settings = { subagentLevels: 2, maxAgents: 4 };
    await captureTools();
    settings = { subagentLevels: 1, maxAgents: 4 };
    await captureTools();

    const firstSpawn = named(captures[0], 'spawn'), secondSpawn = named(captures[1], 'spawn');
    const firstParent = named(captures[0], 'tell_parent'), secondParent = named(captures[1], 'tell_parent');
    assert.match(firstSpawn.description, /8 active agents/);
    assert.match(secondSpawn.description, /4 active agents/);
    assert.notStrictEqual(firstSpawn, secondSpawn, 'tool descriptors are per-session');
    assert.notStrictEqual(firstSpawn.execute, secondSpawn.execute, 'spawn closures capture each child context');
    assert.notStrictEqual(firstParent.execute, secondParent.execute, 'parent-message closures capture each child context');
    assert.strictEqual(firstSpawn.parameters, secondSpawn.parameters, 'only the immutable spawn schema is shared');
    assert.strictEqual(named(captures[0], 'tell').parameters, named(captures[1], 'tell').parameters);
    assert.strictEqual(firstParent.parameters, secondParent.parameters);
    assert.deepEqual(captures[2].map(tool => tool.name).filter(name => ['spawn', 'tell'].includes(name)), [],
      'the current subagent-level setting removes delegation tools on the next child');
  } finally {
    await children.close();
    await memory.close();
    removeDir(dir);
    removeDir(agentDir);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
