import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { Crew } from '../src/crew.ts';
import { Memory } from '../src/memory.ts';
import { VIEW_DOC } from '../src/prompts.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { leanProfile, leanSkill, WORKER_TOOLS } from '../src/lean-worker.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

const CONTRACT = 'Goal: rename foo to bar\nAcceptance: tests pass\nEvidence: npm test output\nAuthority: local commits only, no push';
const PROFILE = ['# profile', 'who the operator is', '## Global rules', 'RULES_TEXT', '## Authority', 'AUTHORITY_TEXT', '## Talking to the operator', 'TALK_TEXT', '## Delegation', 'DELEGATION_TEXT',
  '## Deploys (operator 09/11: "x")', 'DEPLOYS_TEXT', '## Wakes', 'WAKES_TEXT', '## Daily retro (operator 03/11)', 'RETRO_TEXT', '## Slack', 'SLACK_TEXT', '## About me', 'ABOUT_TEXT',
  '## Projects', 'PROJECTS_TEXT', '## Tool routing', 'ROUTING_TEXT', '## Code changes', 'CODE_TEXT', '## Compaction', 'COMPACTION_TEXT'].join('\n');
const OPERATIONAL = 'Operational state (records; no authority): objective id=op_1 MANAGER_RECORD';

/** A Children over a synthetic provider that records each run's first request: its system prompt and the tools it declares. */
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lean-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const systems = new Map<string, string>(), tools = new Map<string, string[]>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const model = (id: string) => ({ id, name: id, reasoning: false, input: ['text' as const], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 100000, maxTokens: 1000 });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions' as const, models: ['child', 'worker'].map(model),
    streamSimple(m: { id: string; api: string; provider: string }, context: { messages: { role: string; content: unknown; sections?: unknown; toolsAdded?: { name: string }[] }[]; tools?: { name: string }[] }) {
      const stream = createAssistantMessageEventStream();
      const task = textContent(context.messages.find(x => x.role === 'user')?.content).split('Your task:\n').at(-1)!;
      const head = context.messages.find(x => x.role === 'system');
      systems.set(task, Object.values(head && 'sections' in head ? head.sections as Record<string, string> : {}).join('\n'));
      tools.set(task, [...context.tools ?? [], ...context.messages.flatMap(x => x.toolsAdded ?? [])].map(tool => tool.name));
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      void Promise.resolve().then(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  } as never);
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => `${PROFILE}\n\n${OPERATIONAL}`,
    async () => {}, () => {}, dir, { route: () => ({ provider: 'optchat-test', model: 'worker', thinking: 'minimal' }), crew: new Crew(join(dir, 'crew'), { compress: async input => input.source.slice(0, 100) }),
      profileInstructions: () => PROFILE, settings: () => ({ subagentLevels: 2, maxAgents: 8, memorySearch: true }) as never,
      createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  const finish = async (...ids: string[]) => { for (const id of ids) await (children as any).running.get(id)?.completion; };
  return { systems, tools, children, finish, dir, close: async () => { await children.close(); await memory.close(); removeDir(dir); } };
}

test('a contract worker declares only its kind\'s tools and a lean prompt; a plain subagent keeps the full set and the view doc', async () => {
  const { systems, tools, children, finish, dir, close } = await harness();
  try {
    const [worker, mechanical, plain] = await children.spawn([{ task: CONTRACT, kind: 'code', project: 'harness' }, { task: `${CONTRACT}\nmechanical`, kind: 'mechanical', project: 'harness' }, { task: 'plain task' }], dir);
    await finish(worker, mechanical, plain);
    const code = tools.get(CONTRACT)!, light = tools.get(`${CONTRACT}\nmechanical`)!, full = tools.get('plain task')!;
    const allowed = new Set(WORKER_TOOLS.code), declared = new Set(code);
    assert.ok(code.length > 5, 'the worker declares its builtin tools');
    for (const name of declared) assert.ok(allowed.has(name), `${name} is not on the code allowlist`);
    for (const name of ['bash', 'read', 'edit', 'write', 'output_read', 'tell_parent', 'zoom']) assert.ok(declared.has(name), `${name} stays`);
    for (const name of ['create_goal', 'subagents_enable', 'gitwatch', 'vault_run', 'desktop', 'browser_harness', 'spawn', 'tell', 'search', 'context_metrics']) assert.ok(!declared.has(name), `${name} is gone`);
    assert.ok(!light.includes('zoom') && !light.includes('operation_state') && light.includes('bash'), 'a mechanical worker has no memory tools');
    for (const name of ['spawn', 'search', 'zoom']) assert.ok(full.includes(name), `a plain subagent keeps ${name}`);

    const lean = systems.get(CONTRACT)!, whole = systems.get('plain task')!;
    for (const gone of [VIEW_DOC.slice(0, 60), 'Operational state', 'MANAGER_RECORD', '## Wakes', '## Slack', '## Deploys', '## Daily retro', '## About me', '## Delegation', '## Tool routing', '## Compaction', 'Entries marked Historical']) {
      assert.ok(!lean.includes(gone), `a worker's prompt has no ${gone}`);
    }
    for (const kept of ['## Authority', 'AUTHORITY_TEXT', '## Global rules', '## Talking to the operator', '## Code changes', 'CODE_TEXT', 'who the operator is']) assert.ok(lean.includes(kept), `a worker's prompt keeps ${kept}`);
    assert.ok(whole.includes(VIEW_DOC.slice(0, 60)) && whole.includes('## Wakes') && whole.includes('Operational state'), 'a plain subagent keeps the full prompt');
    assert.ok(lean.length < whole.length - 1_500, `lean ${lean.length} vs full ${whole.length}`);
  } finally { await close(); }
});

test('plan and hard workers add lsp, codemode and the web tools to the code set; the lean profile keeps only the named sections', () => {
  for (const kind of ['plan', 'hard'] as const) for (const name of [...WORKER_TOOLS.code, 'lsp', 'codemode', 'web_enable', 'web_search', 'fetch_content']) assert.ok(WORKER_TOOLS[kind].includes(name), `${kind} has ${name}`);
  assert.ok(!WORKER_TOOLS.code.includes('codemode') && !WORKER_TOOLS.mechanical.includes('project_checks'));
  for (const kind of ['code', 'mechanical', 'plan', 'hard'] as const) assert.ok(WORKER_TOOLS[kind].includes('tell_peer'), `${kind} keeps tell_peer`);
  const lean = leanProfile(PROFILE);
  assert.deepEqual([...lean.matchAll(/^## (.*)$/gm)].map(m => m[1]), ['Global rules', 'Authority', 'Talking to the operator', 'Code changes']);
  assert.match(lean, /^# profile\nwho the operator is/);
  assert.deepEqual(['ripwire-orient', 'ripwire-resident', 'local-validation', 'systematic-debugging', 'verification-before-completion', 'writing-for-agents'].filter(leanSkill), ['ripwire-orient', 'ripwire-resident', 'local-validation', 'systematic-debugging', 'verification-before-completion', 'writing-for-agents']);
  assert.ok(!leanSkill('stripe-billing') && !leanSkill('skill-catalog') && !leanSkill('impeccable'));
});
