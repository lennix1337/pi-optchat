import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Children } from '../src/agents.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { budgetContext, buildContext, messageChars, refreshBudget, refreshedRun, refreshFraction, refreshPoint, refreshTokens, textContent } from '../src/transcript.ts';
import { Memory, type Part } from '../src/memory.ts';
import { parsePercent } from '../src/settings-page.ts';
import { invalid } from '../src/settings.ts';
import { bindingTierBudget, subagentCompaction } from '../src/agents.ts';
import { TURN_REFRESHED } from '../src/prompts.ts';
import { isCompaction } from './support.ts';
import { assistantMessage } from './messages.ts';
import { estimatedContextTokens, inputTokenBudget, priceTierBudget } from '../src/run-context.ts';
import { removeDir } from './support.ts';

test('with the refresh off the request is the one sent before mid-turn refresh existed', () => {
  assert.equal(refreshBudget(200_000, Number(undefined)), undefined);
  assert.equal(refreshBudget(200_000, 0), undefined);
  assert.equal(refreshBudget(200_000, 0.25), 200_000);
  const run: AgentMessage[] = [{ role: 'user', content: 'task', timestamp: 1 }, assistantMessage([{ type: 'toolCall', id: 't', name: 'date', arguments: { id: 0 } }], 'toolUse'),
    { role: 'toolResult', toolCallId: 't', toolName: 'date', content: [{ type: 'text', text: 'Fri' }], isError: false, timestamp: 3 }];
  assert.deepEqual(buildContext([], refreshedRun(run, 0, TURN_REFRESHED), '<chat>\n</chat>', 'p'), buildContext([], run, '<chat>\n</chat>', 'p'));
});

test('request budgeting coarsens a captured view only through an existing built parent summary', () => {
  const view = `<chat>\n0+1|${'a'.repeat(2_000)}\n1+1|${'b'.repeat(2_000)}\n</chat>`;
  const summaries = new Map<string, { text: string }>([['0:0', { text: 'left' }], ['0:1', { text: 'right' }], ['1:0', { text: 'merged history summary' }]]);
  const memory = { node: (part: Part) => summaries.get(`${part.l}:${part.i}`) } as Memory;
  const task: AgentMessage = { role: 'user', content: 'task', timestamp: 1 };
  const steering: AgentMessage = { role: 'user', content: 'Keep this exact instruction.', timestamp: 2 };
  const hidden: AgentMessage = { role: 'custom', customType: 'policy', content: 'Keep this hidden policy.', display: false, timestamp: 3 };
  const fitted = budgetContext(memory, [], [task, steering, hidden], view, 'system', 100);
  assert.equal(fitted.fits, true);
  assert.ok(fitted.tokens <= 100);
  const taskMessage = fitted.messages.find(message => message.role === 'user');
  assert.ok(taskMessage?.role === 'user' && typeof taskMessage.content !== 'string' && taskMessage.content[0]?.type === 'text'
    && taskMessage.content[0].text === '<chat>\n0+2|merged history summary\n</chat>', 'the replacement summary covers exactly both original view tiles');
  assert.ok(fitted.messages.some(message => message.role === 'user' && message.content === steering.content), 'live user steering is unchanged');
  assert.ok(fitted.messages.some(message => message.role === 'custom' && message.content === hidden.content), 'hidden custom instruction is unchanged');
  assert.ok(!JSON.stringify(fitted.messages).includes('a'.repeat(100)), 'raw content is not silently cut or copied into the request');
});

test('request coarsening estimates unchanged system schemas once per call without stale cross-call caching', () => {
  let serializations = 0;
  let description = 'Current schema';
  const tools = [{ name: 'fixture', description: '', parameters: { toJSON() { serializations++; return { description, type: 'object' }; } } }];
  const canonical: AgentMessage[] = [{ role: 'system', content: '', toolsAdded: tools, timestamp: 0 }];
  const run: AgentMessage[] = [{ role: 'user', content: 'Exact user instruction.', timestamp: 1 }];
  const memory = { node: (part: Part) => ({ text: `Summary ${part.l}:${part.i}` }) } as Memory;
  const view = `<chat>\n${Array.from({ length: 32 }, (_, i) => `${i}+1|${'original '.repeat(100)}`).join('\n')}\n</chat>`;
  const expected = buildContext(canonical, run, '<chat>\n0+32|Summary 5:0\n</chat>', 'system');
  const allowance = estimatedContextTokens(expected);
  serializations = 0;
  const result = budgetContext(memory, canonical, run, view, 'system', allowance);
  assert.equal(serializations, 1, 'coarsening must not reserialize the unchanged system schema');
  assert.deepEqual(result, { messages: expected, tokens: allowance, fits: true });
  description = 'Changed tool schema. '.repeat(80);
  serializations = 0;
  const changed = budgetContext(memory, canonical, run, view, 'system', allowance);
  assert.equal(serializations, 1);
  assert.equal(changed.tokens, estimatedContextTokens(changed.messages));
  assert.equal(changed.fits, false, 'a schema changed in place between calls must still count');
});

test('whole-request budgeting includes prompt, active schemas, memory, prior history, current input, state and status before output reserve', () => {
  const prompt = 'Current system prompt guidance. '.repeat(80);
  const tools = [{ name: 'zoom', description: 'Fetch a page of remembered context. '.repeat(12), parameters: { type: 'object', properties: { id: { type: 'string' } } } }];
  const canonical: AgentMessage[] = [{ role: 'system', content: '', toolsAdded: tools, timestamp: 0 } as AgentMessage];
  const previous: AgentMessage[] = [{ role: 'user', content: 'Prior conversation details stay available.', timestamp: 1 }];
  const run: AgentMessage[] = [{ role: 'user', content: 'Current user task stays verbatim.', timestamp: 2 }];
  const view = '<chat>\n0+1|Remembered memory details.\n</chat>';
  const state = 'Working directory: /workspace/project';
  const status = 'One background agent is still running.';
  const memory = { node: () => undefined } as unknown as Memory;
  const request = buildContext(canonical, run, view, prompt, previous, state, status);
  const tokens = estimatedContextTokens(request);
  const withoutText = (text: string) => estimatedContextTokens(request.map(message => message.role === 'user' && typeof message.content === 'string'
    ? { ...message, content: message.content.replace(text, '') } : message.role === 'user' && Array.isArray(message.content)
      ? { ...message, content: message.content.filter(block => block.type !== 'text' || !block.text.includes(text)) } : message));
  const system = request[0];
  assert.ok(system?.role === 'system');
  assert.ok(tokens > estimatedContextTokens(request.slice(1)), 'the current system prompt is budgeted');
  assert.ok(tokens > estimatedContextTokens(request.map(message => message.role === 'system' ? { ...message, content: '' } : message)), 'the prompt body contributes');
  assert.ok(tokens > estimatedContextTokens(request.map(message => message.role === 'system' ? { ...message, toolsAdded: undefined } : message)), 'active tool schemas contribute');
  for (const text of [view, state, 'Prior conversation details', 'Current user task', status]) {
    assert.ok(tokens > withoutText(text), `${text} contributes to the request estimate`);
  }

  const window = tokens + 500, outputReserve = 501;
  assert.ok(inputTokenBudget(window, 0) >= tokens, 'this request would fit if no output were reserved');
  const inputBudget = inputTokenBudget(window, outputReserve);
  assert.ok(inputBudget < tokens, 'reserving the model output makes the complete request too large');
  const budgeted = budgetContext(memory, canonical, run, view, prompt, inputBudget, previous, state, status);
  assert.equal(budgeted.fits, false, 'one unsummarized memory tile cannot be shortened to hide overflow');
  assert.equal(budgeted.tokens, tokens);
  assert.ok(JSON.stringify(budgeted.messages).includes('Prior conversation details'));
  assert.ok(JSON.stringify(budgeted.messages).includes('Current user task stays verbatim.'));
});

test('repeated refreshes preserve exact visible steering and hidden custom context, including image-bearing tasks', () => {
  const task = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Complete this task.' }, { type: 'image' as const, data: '', mimeType: 'image/png' }], timestamp: 1 };
  const steering: AgentMessage = { role: 'user', content: 'Correction: do not publish anything.', timestamp: 4 };
  const hidden: AgentMessage = { role: 'custom', customType: 'policy', content: 'Keep the result private.', display: false, timestamp: 5 };
  const run: AgentMessage[] = [task, assistantMessage([{ type: 'toolCall', id: 'a', name: 'read', arguments: {} }], 'toolUse'),
    { role: 'toolResult', toolCallId: 'a', toolName: 'read', content: [{ type: 'text', text: 'first' }], isError: false, timestamp: 3 },
    steering, hidden, assistantMessage([{ type: 'toolCall', id: 'b', name: 'read', arguments: {} }], 'toolUse'),
    { role: 'toolResult', toolCallId: 'b', toolName: 'read', content: [{ type: 'text', text: 'second' }], isError: false, timestamp: 6 },
    assistantMessage([{ type: 'toolCall', id: 'c', name: 'read', arguments: {} }], 'toolUse'),
    { role: 'toolResult', toolCallId: 'c', toolName: 'read', content: [{ type: 'text', text: 'third' }], isError: false, timestamp: 8 }];
  const first = refreshedRun(run, 5, TURN_REFRESHED);
  assert.ok(first[0]?.role === 'user');
  assert.deepEqual(first[0].content, [...task.content, { type: 'text', text: `\n\n${TURN_REFRESHED}` }]);
  assert.deepEqual(first.slice(1, 3), [steering, hidden]);
  assert.deepEqual(first.slice(3, 5), run.slice(5, 7));
  const second = refreshedRun(run, 7, TURN_REFRESHED);
  assert.deepEqual(second.slice(1, 3), [steering, hidden]);
  assert.deepEqual(second.slice(-2), run.slice(7));
  assert.equal(second.some(message => message.role === 'toolResult' && message.toolCallId === 'a'), false, 'older completed exchanges move to memory');
});

test('the threshold is typed as 30, 30% or 0.3, OPTCHAT_REFRESH_AT overrides it, and 0 turns it off', () => {
  assert.deepEqual(['30', '30%', '0.3', '8', '0', 'abc'].map(parsePercent), [0.3, 0.3, 0.3, 0.08, 0, NaN]);
  assert.match(invalid('refreshAt', 0.95) ?? '', /from 0% to 90%/);
  assert.equal(refreshFraction(0.3, undefined), 0.3);
  assert.equal(refreshFraction(0.3, '0.08'), 0.08);
  assert.equal(refreshBudget(200_000, refreshFraction(0.3, '0')), undefined);
});

test('a token cap bounds the refresh budget of a large window; 0 leaves the window share, and OPTCHAT_REFRESH_TOKENS overrides it', () => {
  assert.equal(refreshBudget(1_000_000, 0.3, 80_000), 320_000, 'a 1M window refreshes at the 80K-token cap, not at 300K');
  assert.equal(refreshBudget(200_000, 0.3, 80_000), 240_000, 'the window share applies when it is lower');
  assert.equal(refreshBudget(1_000_000, 0.3, 0), 1_200_000, 'no cap');
  assert.equal(refreshBudget(1_000_000, 0, 80_000), undefined, 'refresh off stays off');
  assert.equal(refreshTokens(80, undefined), 80_000, 'the setting is in thousands of tokens');
  assert.equal(refreshTokens(80, '20000'), 20_000);
  assert.equal(refreshTokens(80, '0'), 0);
  assert.equal(refreshTokens(80, 'abc'), 80_000);
  assert.match(invalid('refreshTokensK', -1) ?? '', /of 0 or more/);
});

test('a last step too big to keep under half the budget waits for a smaller one instead of refreshing every call', () => {
  const step = (id: string, text: string): AgentMessage[] => [assistantMessage([{ type: 'toolCall', id, name: 'read', arguments: {} }], 'toolUse'),
    { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: 3 }];
  const run: AgentMessage[] = [{ role: 'user', content: 'task', timestamp: 1 }, ...step('a', 'x'.repeat(600)), ...step('b', 'x'.repeat(600))];
  assert.equal(refreshPoint(run, 0, 1000), undefined);
  assert.equal(refreshPoint([...run, ...step('c', 'small')], 0, 1000)?.cut, 5);
  assert.equal(messageChars({ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', data: '', mimeType: 'image/png' }], timestamp: 1 }), 4_802, 'images count as Pi estimates them');
});

test('subagent compaction reserves output and Pi-estimates the current system prompt, tools, and transcript', () => {
  const system: AgentMessage = { role: 'system', content: 'child prompt', toolsAdded: [{ name: 'parent', description: 'active schema', parameters: { type: 'object' } }], timestamp: 0 };
  const request = [system, { role: 'user' as const, content: 'task', timestamp: 1 }];
  assert.ok(estimatedContextTokens(request) > estimatedContextTokens(request.slice(1)), 'the system prompt and active tools contribute to Pi token estimates');
  assert.deepEqual(subagentCompaction(200_000, 0.3, 8_192), { enabled: true, reserveTokens: 92_000 }, 'turn share 60,000 plus a deferred view of up to 48,000 tokens');
  assert.deepEqual(subagentCompaction(200_000, 0.3, 150_000), { enabled: true, reserveTokens: 160_000 });
  assert.deepEqual(subagentCompaction(200_000, 0), { enabled: true, reserveTokens: 26_384 });
});

test('a model priced higher past a prompt size compacts its children before that size', () => {
  const haiku = { cost: { tiers: [{ inputTokensAbove: 200_000 }, { inputTokensAbove: 100_000 }] } };
  assert.equal(priceTierBudget(haiku), 90_000, '90% of the lowest tier threshold');
  assert.equal(priceTierBudget({ cost: {} }), undefined);
  assert.equal(priceTierBudget(undefined), undefined);
  assert.deepEqual(subagentCompaction(1_000_000, 0.3, 128_000, 90_000), { enabled: true, reserveTokens: 910_000 }, 'compacts at 90,000 tokens, not at the 348,000-token turn share');
  assert.deepEqual(subagentCompaction(1_000_000, 0.3, 128_000), { enabled: true, reserveTokens: 652_000 }, 'without a tier, the turn share stays');
  assert.deepEqual(subagentCompaction(200_000, 0.3, 150_000, 90_000), { enabled: true, reserveTokens: 160_000 }, 'a smaller input budget still wins');
});

test('a price tier binds a child only inside its prompt budget; beyond it the model is priced flat for children', () => {
  const haiku = { contextWindow: 1_000_000, maxTokens: 128_000, cost: { tiers: [{ inputTokensAbove: 100_000 }] } };
  const luna = { contextWindow: 272_000, maxTokens: 128_000, cost: { tiers: [{ inputTokensAbove: 272_000 }] } };
  assert.equal(bindingTierBudget(haiku, 0.3), 90_000, 'Haiku 5.5: 90,000 is under its 348,000-token turn share');
  assert.equal(subagentCompaction(haiku.contextWindow, 0.3, haiku.maxTokens, bindingTierBudget(haiku, 0.3)).reserveTokens, 910_000, 'so it compacts at 90,000 tokens');
  assert.equal(bindingTierBudget(luna, 0.3), undefined, 'gpt-6-luna: its 244,800 tier is past its 129,600-token turn share');
  assert.deepEqual(subagentCompaction(luna.contextWindow, 0.3, luna.maxTokens, bindingTierBudget(luna, 0.3)), { enabled: true, reserveTokens: 142_400 }, 'so it compacts at 129,600 tokens with refreshAt 0.3');
  assert.equal(bindingTierBudget(luna, 0), undefined, 'with refresh off its 130,400-token input budget is still under the tier');
});

test('a real child provider request budgets its current prompt, active tool schemas, and transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-child-budget-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const requests: { context: Context; maxOutputTokens: number }[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('child-budget-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Budget fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000 }],
    streamSimple(model, context, options) {
      requests.push({ context: structuredClone(context), maxOutputTokens: options?.maxTokens ?? model.maxTokens });
      const message = assistantMessage([{ type: 'text', text: 'Child complete.' }], 'stop');
      message.provider = model.provider; message.model = model.id;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'child-budget-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, dir, { settings: () => ({ subagentLevels: 1, maxAgents: 1 }),
      createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    const [id] = await children.spawn([{ task: 'Capture the actual provider request.' }], dir);
    const deadline = Date.now() + 10_000;
    while (children.history.records.get(id)?.state !== 'completed') {
      if (Date.now() > deadline) throw new Error('Timed out waiting for the child provider request.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(requests.length > 0, 'the child reached the fixture provider');
    for (const { context, maxOutputTokens } of requests) {
      const currentSystem = getCurrentSystemMessage(context.messages);
      assert.ok(currentSystem, 'Pi normalized a current system message for the child request');
      const prompt = getCurrentSystemPrompt(context.messages);
      assert.ok(prompt.includes('You are a subagent of OptChat'), `the child request carries its active system prompt: ${prompt.slice(0, 500)}`);
      const names = getCurrentTools(context.messages).map(tool => tool.name);
      assert.ok(['zoom', 'date', 'tell_parent'].every(name => names.includes(name)), `the child request carries active schemas: ${names.join(', ')}`);
      const transcript = context.messages.filter(message => message.role !== 'system');
      const tokens = estimatedContextTokens([currentSystem, ...transcript]);
      assert.ok(tokens > estimatedContextTokens([{ ...currentSystem, toolsAdded: undefined }, ...transcript]), 'the child estimate includes its active tool schemas');
      assert.ok(tokens > estimatedContextTokens([{ ...currentSystem, sections: undefined }, ...transcript]), 'the child estimate includes rendered prompt sections');
      assert.ok(tokens <= inputTokenBudget(100_000, maxOutputTokens), 'child provider request fits the output-reserved input budget');
    }
  } finally { await children.close(); await memory.close(); removeDir(dir); }
});

test('a turn past its threshold is sent as the refreshed view, its task verbatim and only its last tool call, and memory logs every step once', async () => {
  // A 10,000-token window at 10%: a 4,000-character refresh threshold, with room for the complete system prompt.
  await refreshesAtFourThousandChars({ OPTCHAT_REFRESH_AT: '0.1', OPTCHAT_REFRESH_TOKENS: '0' });
});

test('a token cap below the window share refreshes the turn at the cap', async () => {
  // The default 30% of 10,000 tokens would wait for 12,000 characters; a 1,000-token cap refreshes at 4,000, as above.
  await refreshesAtFourThousandChars({ OPTCHAT_REFRESH_AT: undefined, OPTCHAT_REFRESH_TOKENS: '1000' });
});

async function refreshesAtFourThousandChars(env: Record<'OPTCHAT_REFRESH_AT' | 'OPTCHAT_REFRESH_TOKENS', string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-refresh-'));
  const saved = { OPTCHAT_HOME: process.env.OPTCHAT_HOME, OPTCHAT_REFRESH_AT: process.env.OPTCHAT_REFRESH_AT, OPTCHAT_REFRESH_TOKENS: process.env.OPTCHAT_REFRESH_TOKENS };
  const setEnv = (values: Record<string, string | undefined>) => { for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  setEnv({ ...env, OPTCHAT_HOME: dir });
  const task = `Zoom message 0 eight times, then answer. ${'Context for the task. '.repeat(38)}`;
  const captured: Context[] = [], requestTokens: number[] = [], requestPromptChars: number[] = [], requestToolNames: string[][] = [], outputLimits: number[] = [], explicitOutputLimits: (number | undefined)[] = [];
  let calls = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000 }],
      streamSimple(model, context, options) {
        const compression = isCompaction(context);
        if (!compression) {
          requestTokens.push(estimatedContextTokens(context.messages));
          const system = context.messages.find(message => message.role === 'system');
          requestPromptChars.push(system && typeof system.content === 'string' ? system.content.length : 0);
          requestToolNames.push(system?.role === 'system' ? (system.toolsAdded ?? []).map(tool => tool.name) : []);
          outputLimits.push(options?.maxTokens ?? model.maxTokens);
          explicitOutputLimits.push(options?.maxTokens);
          captured.push(structuredClone({ ...context, messages: context.messages.filter(m => m.role !== 'system') }));
        }
        const step = compression ? 0 : ++calls;
        const message = compression ? assistantMessage([{ type: 'text', text: 'Summary.' }], 'stop')
          : step <= 8 ? assistantMessage([{ type: 'toolCall', id: `zoom-${step}`, name: 'zoom', arguments: { id: 0, n: 1 } }], 'toolUse')
          : assistantMessage([{ type: 'text', text: 'Done.' }], 'stop');
        message.provider = model.provider; message.model = model.id;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    await session.prompt(task);
    assert.equal(session.getLastAssistantText(), 'Done.');
    assert.ok(requestPromptChars.every(chars => chars > 0), 'provider context contains the complete system prompt');
    assert.ok(requestToolNames.every(names => names.includes('zoom')), 'provider context contains the active tool schema');
    assert.ok(outputLimits.every(tokens => tokens === 1_000), 'the model output ceiling matches the reserve used for budgeting');
    assert.ok(explicitOutputLimits.every(tokens => tokens === undefined || tokens <= 1_000), 'any explicit provider output limit stays at or below the reserved model ceiling');
    assert.ok(requestTokens.every(tokens => tokens <= inputTokenBudget(10_000, 1_000)), `provider received requests within the assembled input budget: ${requestTokens.join(', ')}`);
    assert.deepEqual(captured.map(c => c.messages.map(m => m.role).join(' ')), [
      'user', 'user assistant toolResult', 'user assistant toolResult assistant toolResult', 'user assistant toolResult assistant toolResult assistant toolResult',
      // Over the threshold: the view now has the turn so far as lines, and the request only the task and the fourth step verbatim.
      'user assistant toolResult', 'user assistant toolResult assistant toolResult', 'user assistant toolResult assistant toolResult assistant toolResult',
      'user assistant toolResult assistant toolResult assistant toolResult assistant toolResult',
      // Over again, counted from the last refresh.
      'user assistant toolResult']);
    const [first, refreshed] = [captured[0].messages[0], captured[4].messages[0]].map(m => textContent(m.content));
    assert.ok(first.endsWith(task) && !first.includes(TURN_REFRESHED));
    assert.ok(refreshed.includes(`\n\n${task}`) && refreshed.endsWith(TURN_REFRESHED), 'the task stays verbatim, then the note');
    const view = refreshed.slice(0, refreshed.indexOf('</chat>'));
    assert.ok(view.includes('|tool: zoom {"id":0,"n":1}') && view.includes('2+1|echo: Summary.'), 'the moved steps are view lines with the original message kind');
    const ids = captured.map(c => c.messages.flatMap(m => m.role === 'assistant' ? m.content.flatMap(b => b.type === 'toolCall' ? [b.id] : []) : []).join(' '));
    assert.deepEqual([ids[4], ids[8]], ['zoom-4', 'zoom-8']);
    const main = join(dir, 'profiles', 'fixture', 'main');
    const kinds = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => (JSON.parse(line) as { kind: string }).kind);
    assert.deepEqual(kinds, ['user', ...Array.from({ length: 8 }, () => ['tool', 'echo']).flat(), 'talk'], 'each step logged once');
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    setEnv(saved);
    removeDir(dir);
  }
}
