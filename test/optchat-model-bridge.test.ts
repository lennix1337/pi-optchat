import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Api, AssistantMessage, Model, ToolCall } from '@earendil-works/pi-ai';
import { ContainerModelBridge, wireOptions } from './optchat-model-bridge.ts';
import { runTransport } from './optchat-container-transport.ts';
import { emptyUsage } from '../src/usage.ts';

const model: Model<Api> = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'https://invalid.local',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const reply = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage =>
  ({ role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() });

test('wire preserves reasoning and cache controls but strips credentials and arbitrary provider configuration', () => {
  const options = wireOptions({ reasoning: 'high', maxTokens: 100, cacheRetention: 'short', toolChoice: 'none',
    apiKey: 'PRIVATE_TOKEN', headers: { Authorization: 'PRIVATE_HEADER' } });
  assert.equal(options.reasoning, 'high');
  assert.equal(options.toolChoice, 'none');
  assert.equal(options.cacheRetention, 'short');
  assert.doesNotMatch(JSON.stringify(options), /PRIVATE|apiKey|headers/);
});

test('bridge routes model events and fails closed when disconnected or canceled', async () => {
  const sent: unknown[] = [];
  const bridge = new ContainerModelBridge(message => { sent.push(message); });
  const stream = bridge.stream(model, { messages: [] }, { sessionId: 'stable-session' });
  const message = reply([{ type: 'text', text: 'ok' }]);
  bridge.receive({ kind: 'event', id: 1, event: { type: 'done', reason: 'stop', message } });
  assert.equal((await stream.result()).stopReason, 'stop');
  const pending = bridge.stream(model, { messages: [] });
  bridge.close();
  assert.equal((await pending.result()).stopReason, 'error');
  const count = sent.length;
  const disconnected = bridge.stream(model, { messages: [] });
  assert.equal((await disconnected.result()).stopReason, 'error');
  assert.equal(sent.length, count, 'closed bridges never submit another request');
  const live = new ContainerModelBridge(message => { sent.push(message); });
  const controller = new AbortController();
  const aborted = live.stream(model, { messages: [] }, { signal: controller.signal });
  controller.abort();
  assert.equal((await aborted.result()).stopReason, 'error');
  assert.ok(sent.some(value => (value as { kind: string }).kind === 'cancel'));
});

test('transport rejects an unbound child without forwarding a model request', async () => {
  let calls = 0;
  await assert.rejects(runTransport(process.execPath, ['-e', `process.stdout.write(JSON.stringify({kind:'ready',bound:false})+'\\n'); setInterval(()=>{},1000);`],
    { kind: 'start', model, prompt: 'fixture', thinking: 'off', cwd: '.' }, async function* () { calls++; }, 5000), /did not activate real OptChat/);
  assert.equal(calls, 0);
});

test('transport stops once on provider failure, omits sensitive diagnostics, and never retries', async () => {
  let calls = 0;
  const child = `process.stdin.once('data',d=>{const c=JSON.parse(d);process.stdout.write(JSON.stringify({kind:'ready',bound:true,tools:['zoom','output_read','shell_start'],provider:c.model.provider,model:c.model.id,thinking:c.thinking})+'\\n');process.stdout.write(JSON.stringify({kind:'request',id:1,context:{messages:[]}})+'\\n')});setInterval(()=>{},1000);`;
  await assert.rejects(runTransport(process.execPath, ['-e', child],
    { kind: 'start', model, prompt: 'fixture', thinking: 'off', cwd: '.' }, async function* () { calls++; throw new Error('PRIVATE_PROVIDER_TOKEN'); }, 5000),
    error => {
      assert.match(String(error), /transport failed/);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
      assert.equal((error as Error & { evidence: { requests: unknown[] } }).evidence.requests.length, 1, 'failure retains attempted-call evidence');
      return true;
    });
  assert.equal(calls, 1);
});

test('orderly child shutdown cancels background compaction without invalidating a completed main result', async () => {
  const child = `process.stdin.once('data',d=>{const c=JSON.parse(d);const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');send({kind:'ready',bound:true,tools:['zoom','output_read','shell_start'],provider:c.model.provider,model:c.model.id,thinking:c.thinking});send({kind:'request',id:1,context:{messages:[]}});setTimeout(()=>{send({kind:'result',messages:[],patch:'preserved'});send({kind:'cancel',id:1});process.exit(0)},100)});`;
  const report = await runTransport(process.execPath, ['-e', child],
    { kind: 'start', model, prompt: 'fixture', thinking: 'off', cwd: '.' }, async function* (_context, options) {
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('Canceled pending summary');
    }, 5000);
  assert.equal(report.requests[0].canceled, true);
  assert.equal(report.requests[0].stopReason, 'aborted');
  assert.equal((report.result as { patch: string }).patch, 'preserved');
});

test('transport enforces task timeout on a silent child', async () => {
  await assert.rejects(runTransport(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { kind: 'start', model, prompt: 'fixture', thinking: 'off', cwd: '.' }, async function* () {}, 50), /timed out/);
});

test('real OptChat continues from failed literal-regex diagnostics to an actual edit without weakening recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-diagnostic-'));
  const before = { home: process.env.OPTCHAT_HOME, agent: process.env.PI_CODING_AGENT_DIR, rg: process.env.RIPGREP_CONFIG_PATH };
  process.env.OPTCHAT_HOME = join(root, 'home'); process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  delete process.env.RIPGREP_CONFIG_PATH;
  await writeFile(join(root, 'fixture.txt'), 'before');
  let turn = 0;
  try {
    const report = await runTransport(process.execPath, ['--import', 'tsx', 'test/optchat-container-agent.ts'],
      { kind: 'start', model, prompt: 'Run diagnostics, then update fixture.txt.', thinking: 'off', cwd: root }, async function* (context) {
        if (JSON.stringify(context.messages.at(-1)).includes('\\n\\nCompaction:')) {
          const message = reply([{ type: 'text', text: 'echo: Diagnostic failed; originals retained.' }]);
          yield { type: 'done', reason: 'stop', message };
          return;
        }
        turn++;
        if (turn === 2) assert.ok(context.messages.some(message => message.role === 'toolResult' && message.isError));
        const calls: Array<Pick<ToolCall, 'name' | 'arguments'>> = [
          { name: 'bash', arguments: { command: 'rg -n "class CharField|MaxLengthValidator" missing-diagnostic-input' } },
          { name: 'bash', arguments: { command: "grep -n -E 'class CharField|MaxLengthValidator' missing-diagnostic-input" } },
          { name: 'edit', arguments: { path: 'fixture.txt', edits: [{ oldText: 'before', newText: 'after' }] } },
        ];
        const content: AssistantMessage['content'] = turn <= calls.length
          ? [{ type: 'toolCall', id: `diagnostic-${turn}`, ...calls[turn - 1] }]
          : [{ type: 'text', text: 'done' }];
        const message = reply(content, turn <= calls.length ? 'toolUse' : 'stop');
        yield { type: 'done', reason: turn <= calls.length ? 'toolUse' : 'stop', message };
      });
    assert.equal(turn, 4);
    assert.equal(await readFile(join(root, 'fixture.txt'), 'utf8'), 'after');
    assert.equal(report.ready?.bound, true);
  } finally {
    for (const [key, value] of [['OPTCHAT_HOME', before.home], ['PI_CODING_AGENT_DIR', before.agent], ['RIPGREP_CONFIG_PATH', before.rg]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('real OptChat runs in a separate process: host forwards only model events, child executes and returns actual tool result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-bridge-'));
  const oldHome = process.env.OPTCHAT_HOME, oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.OPTCHAT_HOME = join(root, 'home');
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  const contexts: string[] = [];
  const sessions: string[] = [];
  try {
    const report = await runTransport(process.execPath, ['--import', 'tsx', 'test/optchat-container-agent.ts'],
      { kind: 'start', model, prompt: 'Write the isolated transport probe, then confirm the result.', thinking: 'off', cwd: join(root, 'work') },
      async function* (context, options) {
        const json = JSON.stringify(context);
        contexts.push(json); sessions.push(options.sessionId);
        const message = contexts.length === 1
          ? reply([{ type: 'toolCall', id: 'write-probe', name: 'write', arguments: { path: 'transport-probe.txt', content: 'verified actual OptChat tool' } }], 'toolUse')
          : reply([{ type: 'text', text: 'confirmed' }]);
        yield { type: 'start', partial: message };
        yield { type: 'done', reason: contexts.length === 1 ? 'toolUse' : 'stop', message };
      });
    assert.equal(report.ready?.bound, true);
    assert.equal(contexts.length, 2);
    assert.match(contexts[0], /You are OptChat/);
    assert.match(contexts[1], /toolResult/);
    assert.equal(sessions[0], sessions[1], 'one stable provider cache key throughout the task');
    assert.equal(await readFile(join(root, 'work/transport-probe.txt'), 'utf8'), 'verified actual OptChat tool');
    assert.equal(report.requests.length, 2);
  } finally {
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    await rm(root, { recursive: true, force: true });
  }
});
