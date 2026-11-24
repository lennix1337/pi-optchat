import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { HOT_TEXTS, Memory } from '../src/memory.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { boundedMessage } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction, removeDir } from './support.ts';

const MAX_HOT_TEXT_BYTES = 2 * 1024 * 1024;

test('boundedMessage drops duplicate details.truncation.content while keeping truncation metadata', () => {
  const duplicated = 'line of output\n'.repeat(3500);
  const details = {
    fullOutputPath: '/tmp/fake-output.log',
    truncation: {
      content: duplicated,
      truncated: true,
      truncatedBy: 'bytes',
      totalLines: 3500,
      totalBytes: 52500,
      outputLines: 3000,
      outputBytes: 45000,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: 2000,
      maxBytes: 51200,
    },
  };
  const small = {
    role: 'toolResult' as const,
    toolCallId: 'c1',
    toolName: 'read',
    content: [{ type: 'text' as const, text: 'short text' }],
    details,
    isError: false,
    timestamp: 1,
  };
  const cleanedSmall = boundedMessage(small);
  assert.equal(cleanedSmall.role, 'toolResult');
  const smallDetails = cleanedSmall.details as { fullOutputPath?: string; truncation?: Record<string, unknown> };
  assert.equal(smallDetails.fullOutputPath, '/tmp/fake-output.log');
  assert.equal(smallDetails.truncation?.truncated, true);
  assert.equal(smallDetails.truncation?.outputLines, 3000);
  assert.equal('content' in (smallDetails.truncation ?? {}), false, 'duplicate truncation.content must be stripped');

  const big = { ...small, content: [{ type: 'text' as const, text: duplicated }] };
  const cleanedBig = boundedMessage(big);
  assert.equal(cleanedBig.role, 'toolResult');
  const bigDetails = cleanedBig.details as { truncation?: Record<string, unknown> };
  assert.equal(bigDetails.truncation?.truncated, true);
  assert.equal('content' in (bigDetails.truncation ?? {}), false, 'capped toolResult must also strip truncation.content');
});

test('real Pi session persists truncated read and recoverable bash results without details.truncation.content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-rss-trunc-'));
  const prior = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(root, 'home');
  const profile = 'rss-trunc';
  createProfile(profile);
  saveConfig(profilePath(profile), { ...loadConfig(profilePath(profile)), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, recoverableOutput: true });
  const bigFile = join(root, 'large.txt');
  writeFileSync(bigFile, Array.from({ length: 1500 }, (_, i) => `synthetic_row_${i} ${'alpha beta gamma '.repeat(3)}`).join('\n'));

  let calls = 0;
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      let content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop';
      if (isCompaction(context)) content = [{ type: 'text', text: 'echo: summarized large tool output.' }];
      else if (calls === 0) {
        calls++;
        content = [
          { type: 'toolCall', id: 'r1', name: 'read', arguments: { path: bigFile } },
          { type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('synthetic_out_line_0123456789\\n'.repeat(2500))"` } },
        ];
        stopReason = 'toolUse';
      } else {
        calls++;
        content = [{ type: 'text', text: 'Tools complete.' }];
      }
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(root, join(root, 'sessions'));
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager });
  session.extensionRunner!.setFlagValue('optchat-profile', profile);
  try {
    await session.bindExtensions({ mode: 'print', onError: error => { throw new Error(error.error); } });
    await session.prompt('Read the large synthetic file and run a verbose command.');
    const toolEntries = manager.getEntries().filter(e => e.type === 'message' && e.message.role === 'toolResult');
    const byName = new Map(toolEntries.map(e => e.type === 'message' && e.message.role === 'toolResult' ? [e.message.toolName, e.message] as const : ['', null] as const));
    for (const name of ['read', 'bash']) {
      const msg = byName.get(name);
      assert.ok(msg && msg.role === 'toolResult', `expected ${name} toolResult`);
      const details = msg.details as { truncation?: Record<string, unknown> } | undefined;
      assert.equal(details?.truncation?.truncated, true, `${name} truncation metadata remains intact for renderers`);
      assert.ok(typeof details?.truncation?.outputLines === 'number' && details.truncation.outputLines > 0);
      assert.equal('content' in (details?.truncation ?? {}), false, `${name} must not retain duplicate details.truncation.content`);
    }
    const sessionFile = manager.getSessionFile();
    if (sessionFile) {
      const lines = readFileSync(sessionFile, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { type?: string; message?: { role?: string; toolName?: string; details?: { truncation?: Record<string, unknown> } } });
      const persisted = lines.filter(l => l.type === 'message' && l.message?.role === 'toolResult');
      assert.equal(persisted.length, 2);
      for (const entry of persisted) {
        assert.equal('content' in (entry.message?.details?.truncation ?? {}), false, `${entry.message?.toolName} persisted session jsonl must not store duplicate truncation.content`);
      }
    }
  } finally {
    await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    if (prior === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = prior;
    removeDir(root);
  }
});

test('Memory bounds hot live text bytes even below HOT_TEXTS count and keeps full text zoomable from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-rss-hot-bytes-'));
  const chunk = (i: number) => `payload_${i}_` + 'x'.repeat(60_000) + `_tail_${i}`;
  let memory = new Memory(dir, async input => `echo: summary ${input.part.l}:${input.part.i}`, () => {});
  try {
    for (let i = 0; i < 80; i++) {
      memory.append('echo', chunk(i));
    }
    await memory.settle(AbortSignal.timeout(10_000), 'tree');
    const afterSettle = memory.stats();
    assert.ok(afterSettle.liveTextBytes <= MAX_HOT_TEXT_BYTES, `liveTextBytes ${afterSettle.liveTextBytes} exceeded ${MAX_HOT_TEXT_BYTES}`);
    assert.ok(afterSettle.liveTexts < 80, `expected oldest large entries to chill, got liveTexts=${afterSettle.liveTexts}`);
    assert.equal(memory.root[0].text, chunk(0), 'chilled entry still reads full text from disk');
    assert.ok(memory.zoom(0, 1, 0, 1000).includes('payload_0_'));
    await memory.close();

    memory = await Memory.open(dir, async input => `echo: summary ${input.part.l}:${input.part.i}`, () => {});
    const afterReopen = memory.stats();
    assert.ok(afterReopen.liveTextBytes <= MAX_HOT_TEXT_BYTES, `reopened liveTextBytes ${afterReopen.liveTextBytes} exceeded ${MAX_HOT_TEXT_BYTES}`);
    assert.equal(memory.root[0].text, chunk(0));
    assert.equal(memory.root[79].text, chunk(79));
  } finally {
    await memory.close();
    removeDir(dir);
  }
});

test('Memory chills entries that finish summarizing after falling past HOT_TEXTS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-rss-late-chill-'));
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const memory = new Memory(dir, async input => {
    if (input.part.l === 0 && input.part.i === 0) await hold;
    return `user: sum ${input.part.l}:${input.part.i}`;
  }, () => {});
  try {
    memory.append('user', 'late_summary_target_' + 'a'.repeat(1000));
    for (let i = 1; i <= HOT_TEXTS + 5; i++) {
      memory.append('user', `msg ${i}`);
    }
    assert.equal(Object.getOwnPropertyDescriptor(memory.root[0], 'text')?.writable, true, 'unbuilt entry stays hot until summarized');
    release();
    await memory.settle(AbortSignal.timeout(15_000), 'tree');
    assert.equal(Object.getOwnPropertyDescriptor(memory.root[0], 'text')?.writable, undefined, 'entry past HOT_TEXTS must chill once its summary finishes');
    assert.equal(memory.root[0].text, 'late_summary_target_' + 'a'.repeat(1000));
  } finally {
    release();
    await memory.close();
    removeDir(dir);
  }
});
