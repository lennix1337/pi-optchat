import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children, subagentCompaction } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { DEFAULT_SETTINGS, invalid, readSettings, type Settings } from '../src/settings.ts';
import { refreshBudget, refreshFraction } from '../src/transcript.ts';
import { assistantMessage } from './messages.ts';
import { removeDir } from './support.ts';

const WINDOW = 1_000_000, MAX_OUTPUT = 128_000;
const CONTRACT = ['Goal: report done.', 'Acceptance: a report.', 'Evidence: none.', 'Authority: read only.'].join('\n');

/** Spawns children on a 1M-window model and reports the context size at which Pi compacts each one. */
async function compactsAt(settings: Partial<Settings>, task: { kind?: 'code' | 'mechanical' }) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-worker-compact-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('worker-compact-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'big', name: 'Million-token fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: WINDOW, maxTokens: MAX_OUTPUT }],
    streamSimple(model) {
      const message = assistantMessage([{ type: 'text', text: 'Done.' }], 'stop');
      message.provider = model.provider; message.model = model.id;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const choice = { provider: 'worker-compact-test', model: 'big', thinking: 'minimal' } as const;
  const children = new Children(memory, new ModelRegistry(runtime), () => choice, () => '', async () => {}, () => {}, dir,
    { settings: () => ({ subagentLevels: 1, maxAgents: 2, ...settings }), createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    const [id] = await children.spawn([task.kind ? { task: CONTRACT, kind: task.kind } : { task: 'Report that you are done.' }], dir);
    const reserve = children.live(id)?.session.settingsManager.getCompactionSettings().reserveTokens;
    assert.equal(typeof reserve, 'number', 'the child session carries compaction settings');
    return WINDOW - (reserve as number);
  } finally { await children.close(); await memory.close(); removeDir(dir); }
}

const turnShare = WINDOW - subagentCompaction(WINDOW, refreshFraction(DEFAULT_SETTINGS.refreshAt), MAX_OUTPUT).reserveTokens;

test('a contract worker on a 1M-token window compacts at the worker threshold, not at the turn share', async () => {
  assert.equal(turnShare, 348_000, 'the share every child compacted at before');
  assert.equal(await compactsAt({}, { kind: 'code' }), 120_000);
  assert.equal(await compactsAt({ workerCompactAtTokens: 80_000 }, { kind: 'mechanical' }), 80_000, 'the setting picks the threshold');
});

test('a subagent without a kind keeps the turn share, and 0 turns the worker threshold off', async () => {
  assert.equal(await compactsAt({}, {}), turnShare);
  assert.equal(await compactsAt({ workerCompactAtTokens: 0 }, { kind: 'code' }), turnShare);
});

test('a worker threshold above the turn share does not raise it, and the manager refresh is not touched', () => {
  assert.equal(subagentCompaction(WINDOW, 0.3, MAX_OUTPUT, 500_000).reserveTokens, WINDOW - 348_000, 'a larger cap never wins over the prompt budget');
  assert.equal(refreshBudget(WINDOW, refreshFraction(DEFAULT_SETTINGS.refreshAt), 0), 1_200_000, 'the main agent still refreshes on the window share');
});

test('workerCompactAtTokens defaults to 120,000, accepts an override and 0, and refuses a negative or fractional value', () => {
  assert.equal(DEFAULT_SETTINGS.workerCompactAtTokens, 120_000);
  assert.equal(readSettings({ workerCompactAtTokens: 60_000 }).workerCompactAtTokens, 60_000);
  assert.equal(readSettings({ workerCompactAtTokens: 0 }).workerCompactAtTokens, 0);
  assert.equal(readSettings({}).workerCompactAtTokens, 120_000, 'a config.json from before the setting takes the default');
  assert.match(invalid('workerCompactAtTokens', -1) ?? '', /of 0 or more/);
  assert.match(invalid('workerCompactAtTokens', 1.5) ?? '', /whole number/);
});
