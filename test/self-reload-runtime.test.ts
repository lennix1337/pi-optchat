import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import * as pinnedPi from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { RELOAD_ENTRY } from '../src/self-reload.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

const sdk: typeof pinnedPi = process.env.OPTCHAT_TEST_PI_ENTRY
  ? await import(pathToFileURL(process.env.OPTCHAT_TEST_PI_ENTRY).href) : pinnedPi;

test('native self reload replaces extensions then resumes tool execution and final answer exactly once', { timeout: 20000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-self-reload-')), prior = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let network = 0;
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('External fetch forbidden'); });
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: any[]) {
    if (typeof args[0] === 'number' || typeof args[0] === 'object' && args[0]?.port) { network++; throw new Error('External socket forbidden'); }
    return (connect as Function).apply(this, args);
  });
  createProfile('reload-fixture');
  const profile = profilePath('reload-fixture');
  saveConfig(profile, { ...loadConfig(profile), compactor: { provider: 'reload-fixture', model: 'fixture', thinking: 'off' } });
  const receipt = join(dir, 'effect-count.txt');
  let generations = 0, executions = 0, inspections = 0, calls = 0, reloads = 0;
  let continuationSeen = false, final = '';
  const errors: string[] = [], notices: string[] = [];
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('reload-fixture', { api: 'openai-completions', apiKey: 'fixture', baseUrl: 'https://invalid.local',
    models: [{ id: 'fixture', name: 'Offline reload fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      assert.equal(isCompaction(context), false, 'tiny fixture must not call a summarizer');
      const stage = calls++;
      const hasNotice = context.messages.some(message => textContent(message.content).includes('Native Pi reload completed.'));
      let content: AssistantMessage['content'];
      if (stage === 0) content = [{ type: 'toolCall', id: 'effect-1', name: 'fixture_effect', arguments: {} }];
      else if (stage === 1) content = [{ type: 'toolCall', id: 'reload-1', name: 'self_reload', arguments: { checkpoint: `Verified effect-count=1 at ${receipt}. Next inspect that receipt, never repeat fixture_effect.` } }];
      else if (stage === 2) {
        assert.equal(generations, 1, 'tool result must reach old run before replacement');
        content = [{ type: 'text', text: 'Checkpoint saved; ending this run for reload.' }];
      } else if (stage === 3) {
        continuationSeen = hasNotice; assert.equal(hasNotice, true); assert.equal(generations, 2);
        assert.ok(context.messages.some(message => textContent(message.content).includes('not a new user instruction or authorization')));
        content = [{ type: 'toolCall', id: 'inspect-1', name: 'fixture_inspect', arguments: {} }];
      } else {
        assert.equal(stage, 4, 'no extra continuation or reload loop');
        assert.ok(context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'inspect-1'));
        final = 'Resumed and verified effect-count=1.'; content = [{ type: 'text', text: final }];
      }
      const stopReason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
      const message: AssistantMessage = { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); }); return stream;
    } });
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, disabledBuiltinExtensions: ['mcp', 'codemode'],
    extensionFactories: [api => { generations++; optchat(api); }, api => {
      api.registerTool({ name: 'fixture_effect', label: 'Local fixture effect', description: 'Write disposable receipt once.', parameters: Type.Object({}), async execute() {
        executions++; writeFileSync(receipt, String(executions)); return { content: [{ type: 'text', text: 'effect-count=1' }], details: {} };
      } });
      api.registerTool({ name: 'fixture_inspect', label: 'Read fixture receipt', description: 'Inspect disposable receipt.', annotations: { readOnlyHint: true }, parameters: Type.Object({}), async execute() {
        inspections++; assert.equal(readFileSync(receipt, 'utf8'), '1'); return { content: [{ type: 'text', text: 'verified effect-count=1' }], details: {} };
      } });
    }] });
  await loader.reload();
  const manager = sdk.SessionManager.create(dir, join(dir, 'sessions'));
  manager.appendCustomEntry('optchat.profile', { name: 'reload-fixture' });
  const { session } = await sdk.createAgentSession({ cwd: dir, modelRuntime: runtime, model: runtime.getModel('reload-fixture', 'fixture'), settingsManager, resourceLoader: loader, sessionManager: manager, tools: ['fixture_effect', 'self_reload', 'fixture_inspect'] });
  try {
    await session.bindExtensions({ mode: 'print', onError: event => errors.push(event.error),
      uiContext: { ...session.extensionRunner!.getUIContext(), notify: text => { notices.push(text); } },
      commandContextActions: { reload: async () => { reloads++; await session.reload(); } } as any });
    session.subscribe(event => { if (event.type === 'agent_settled' && final) finish(); });
    await session.prompt('Do one disposable local action, reload, and verify it without repeating it.');
    await finished;
    assert.equal(reloads, 1); assert.equal(generations, 2); assert.equal(executions, 1); assert.equal(inspections, 1); assert.equal(calls, 5); assert.equal(continuationSeen, true);
    const entries = manager.getBranch();
    const ticket = entries.findLast(e => e.type === 'custom' && e.customType === RELOAD_ENTRY);
    assert.ok(ticket?.type === 'custom'); assert.equal((ticket.data as any).state, 'completed');
    assert.equal(entries.filter(e => e.type === 'custom_message' && e.customType === 'optchat-reload-resume').length, 1);
    assert.equal(entries.filter(e => e.type === 'message' && e.message.role === 'user').length, 1, 'continuation is not fabricated human input');
    assert.deepEqual(errors, []); assert.equal(network, 0);
    assert.equal(final, 'Resumed and verified effect-count=1.');
    await session.reload();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 5, 'later manual reload never replays continuation');
    console.log(JSON.stringify({ generations, reloads, executions, inspections, calls, network, final, nativeRuntime: process.env.OPTCHAT_TEST_PI_ENTRY ?? 'pinned' }));
  } finally {
    await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    if (prior === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = prior;
    removeDir(dir);
  }
});
