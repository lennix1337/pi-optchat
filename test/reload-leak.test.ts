import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from 'node:inspector/promises';
import { fileURLToPath } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createProfile } from '../src/profiles.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction } from './support.ts';

// Timers made from src/ that are still pending, found by wrapping the globals before the extension loads.
const pending = new Map<unknown, string>();
const real = { setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout, clearInterval: globalThis.clearInterval, clearTimeout: globalThis.clearTimeout };
const origin = () => (new Error().stack ?? '').split('\n').slice(2).find(line => /[\\/]src[\\/]/.test(line) && !/[\\/]node_modules[\\/]|core[\\/]extensions/.test(line))?.trim().replace(/^at /, '').replace(/.*[\\/]src[\\/]/, 'src/');
const patch = globalThis as unknown as Record<string, unknown>;
patch.setInterval = (run: () => void, ms?: number, ...args: unknown[]) => {
  const handle = real.setInterval(run, ms, ...args), from = origin();
  if (from) pending.set(handle, `every ${ms} ms from ${from}`);
  return handle;
};
patch.setTimeout = (run: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const from = origin();
  const handle: unknown = real.setTimeout((...a: unknown[]) => { pending.delete(handle); return run(...a); }, ms, ...args);
  if (from && (ms ?? 0) >= 60_000) pending.set(handle, `after ${ms} ms from ${from}`);
  return handle;
};
patch.clearInterval = (handle: never) => { pending.delete(handle); return real.clearInterval(handle); };
patch.clearTimeout = (handle: never) => { pending.delete(handle); return real.clearTimeout(handle); };

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 20)); gc(); } };
const extension = fileURLToPath(new URL('../src/index.ts', import.meta.url));

/** Arrays shaped like the memory index (`{ i, kind, text, date, size }` entries), found by V8's own heap walk. */
async function memoryIndexes(): Promise<number> {
  const session = new Session(); session.connect();
  try {
    const { result: prototype } = await session.post('Runtime.evaluate', { expression: 'Array.prototype' });
    const { objects } = await session.post('Runtime.queryObjects', { prototypeObjectId: prototype.objectId! });
    const { result } = await session.post('Runtime.callFunctionOn', { objectId: objects.objectId!, returnByValue: true,
      functionDeclaration: `function () { return this.filter(a => a.length > 0 && a[0] && typeof a[0] === 'object' && 'kind' in a[0] && 'size' in a[0] && 'date' in a[0] && 'text' in a[0]).length; }` });
    return Number(result.value);
  } finally { session.disconnect(); }
}

const HANDOFF = Symbol.for('pi-optchat.shell-handoff');
type Handoff = { jobs: { endObserver?: unknown } } | undefined;

// Pi loads an extension through jiti without a module cache, so every reload evaluates a fresh copy of src/ in the same process.
test('after /reload, the previous OptChat instance holds no memory index, timer, exit hook or shell observer', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-reload-leak-'));
  const name = 'reload-leak'; createProfile(name);
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 60000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const text = isCompaction(context) ? 'tool: none; echo: ok.' : 'OK';
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: { ...emptyUsage(), input: 10, totalTokens: 10 } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, additionalExtensionPaths: [extension] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions')); manager.appendCustomEntry('optchat.profile', { name });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager });
  await session.bindExtensions({ mode: 'tui', onError: () => {}, uiContext: { ...session.extensionRunner.getUIContext(), notify: () => {} } });
  const handoff = globalThis as Record<symbol, Handoff>;
  try {
    await session.prompt('Say OK.');
    const exitHooks = process.listenerCount('exit');
    const indexes: number[] = [];
    for (let reload = 0; reload < 4; reload++) {
      await session.reload();
      await settle();
      // Teardown work still in flight on a busy machine holds the old instance for a moment; a real leak outlasts every retry.
      let count = await memoryIndexes();
      for (let retry = 0; count > 1 && retry < 25; retry++) { await settle(); count = await memoryIndexes(); }
      indexes.push(count);
    }
    assert.deepEqual(indexes, [1, 1, 1, 1], 'one memory index stays alive across reloads');
    assert.ok(process.listenerCount('exit') - exitHooks <= 1, `the shell reaper's exit hook is registered once per process, not once per reload (${exitHooks} before, ${process.listenerCount('exit')} after 4 reloads)`);

    const long = new Map<string, number>();
    for (const timer of pending.values()) long.set(timer, (long.get(timer) ?? 0) + 1);
    assert.deepEqual([...long].filter(([, count]) => count > 1), [], 'a timer of one minute or more is pending once, for the live instance only');

    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
    const handed = handoff[HANDOFF];
    assert.ok(handed, 'a reload hands its shells over');
    assert.equal(handed.jobs.endObserver, undefined, 'the shells kept for the next instance do not report into the closing one');
  } finally {
    delete handoff[HANDOFF];
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluating shell-reaper again, as every /reload does, adds no exit hook', async () => {
  await import('../src/shell-reaper.ts');
  const before = process.listenerCount('exit');
  for (let copy = 1; copy <= 3; copy++) await import(`../src/shell-reaper.ts?copy=${copy}`);
  assert.equal(process.listenerCount('exit'), before);
});
