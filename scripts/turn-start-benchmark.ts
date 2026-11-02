// Offline turn-start benchmark. It runs the real OptChat extension in a headless Pi session on a synthetic profile
// (a temp OPTCHAT_HOME, never ~/.optchat) with a fixture model that makes no provider call, then reports p50/p95 per
// stage: the wall time from prompt to the provider request, the whole turn, and each context stage from context_metrics.
// Sizes follow the operator's profile (memory view near its 128 KB budget, ~100 KB operational state, open commitments,
// 14 KB AGENTS.md); message count is the one knob that stands in for a long-running chat.
//
// Usage: node --experimental-transform-types --no-warnings scripts/turn-start-benchmark.ts [--messages=20000] [--turns=40] [--warmup=5] [--gap=0] [--cpu-profile=<file>]
// --gap=<ms> waits between turns (untimed) like a person typing; 0 runs turns back to back, the worst case for background work.
// Checkpoints run in the background after each settle: at gap 0 the queue can still be draining when the stats are read, so the
// checkpoint stage is partial there; use a gap of a few seconds to see its full durations. Stages are read through /optchat-perf.
import '../test/support.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session as InspectorSession } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, rememberProfile, saveConfig } from '../src/profiles.ts';
import { addCommitment } from '../src/commitments.ts';
import { updateOperationalState } from '../src/operational-state.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import type { Entry, Kind, Summary } from '../src/memory.ts';

const PROFILE = 'bench';
const CONTEXT_WINDOW = 200_000;
const KINDS: readonly Kind[] = ['user', 'talk', 'tool', 'echo', 'note', 'work'];
const SIZES: Record<Kind, [number, number]> = { user: [60, 260], talk: [150, 1400], tool: [40, 160], echo: [80, 2600], note: [40, 200], work: [60, 300] };
const SHARE: Record<Kind, number> = { user: 0.12, talk: 0.3, tool: 0.22, echo: 0.22, note: 0.06, work: 0.08 };
const NODE_BYTES = 512;

/** Deterministic pseudo-random numbers: two runs build the same fixture. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
const WORDS = 'the plan step check build test merge deploy memory view summary operator decision evidence file path commit branch review model cache turn tool result shell agent queue lesson note'.split(' ');
function sentence(next: () => number, length: number) {
  let text = '';
  while (text.length < length) text += `${WORDS[Math.floor(next() * WORDS.length)]} `;
  return text.slice(0, length).trimEnd();
}
function kindAt(next: () => number): Kind {
  let roll = next();
  for (const kind of KINDS) { roll -= SHARE[kind]; if (roll < 0) return kind; }
  return 'work';
}
const bytesOf = (text: string) => Buffer.byteLength(text, 'utf8');
const dayOf = (i: number) => `2026-10-${String(8 + Math.floor(i / 2000)).padStart(2, '0')}`;

/** A store the Memory opens as-is: every message has its own line and a built tree, so no compactor is ever called. */
function writeStore(directory: string, messages: number) {
  const next = random(20261102), main = join(directory, 'main'), tree = join(directory, 'tree');
  mkdirSync(main, { recursive: true }); mkdirSync(tree, { recursive: true });
  const entries: Entry[] = [];
  for (let i = 0; i < messages; i++) {
    const kind = kindAt(next), [min, max] = SIZES[kind];
    entries.push({ i, kind, text: sentence(next, min + Math.floor(next() * (max - min))), date: new Date(Date.UTC(2026, 9, 8, 0, i)).toISOString() });
  }
  const lines = new Map<string, string[]>();
  const append = (day: string, file: 'main' | 'tree', line: string) => {
    const key = `${file}/${day}.jsonl`;
    lines.set(key, [...lines.get(key) ?? [], line]);
  };
  for (const entry of entries) append(dayOf(entry.i), 'main', JSON.stringify(entry));
  // Level 0 is the message itself (short enough to be its own line); higher levels summarize their halves.
  for (let level = 0; 2 ** level <= messages; level++) {
    for (let i = 0; i < Math.floor(messages / 2 ** level); i++) {
      const first = i * 2 ** level;
      const text = level === 0 ? `${entries[first].kind}: ${entries[first].text}`.slice(0, NODE_BYTES)
        : sentence(next, 240 + Math.floor(next() * 200));
      const node: Summary = { l: level, i, text, size: bytesOf(text) };
      append(dayOf(first), 'tree', JSON.stringify(node));
    }
  }
  for (const [key, rows] of lines) writeFileSync(join(directory, key.split('/')[0], key.split('/')[1]), rows.join('\n') + '\n');
}

/** A profile as the operator's: 14 KB instructions, ~100 KB operational state and open commitments, a built memory. */
async function createFixtureProfile(messages: number) {
  createProfile(PROFILE);
  const dir = profilePath(PROFILE);
  const config = loadConfig(dir);
  // Status file on, ai-memory off: a benchmark must never write pages into the operator's memory service.
  saveConfig(dir, { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' },
    syncStatus: true, syncAiMemory: false, syncOptMem: false, heartbeatMinutes: 0, heartbeatWakes: 1, memorySearch: false, previousExchange: false, refreshTokensK: 64 });
  const agents = Array.from({ length: 220 }, (_, n) => `- Standing instruction ${n}: preserve operator decisions, cite evidence, never repeat an uncertain external effect.`).join('\n');
  writeFileSync(join(dir, 'AGENTS.md'), `# ${PROFILE}\n\n${agents}\n`);
  writeStore(dir, messages);
  for (let n = 0; n < 60; n++) addCommitment(dir, { text: `Benchmark commitment ${n}: keep the operator's work moving with evidence`, source: String(n), owner: n % 3 ? 'optchat' : 'operator', next: 'check the next step', dueInMinutes: 600 + n });
  for (let n = 0; n < 200; n++) {
    updateOperationalState(join(dir, 'operational-state.json'), n % 5 === 0
      ? { kind: 'authorization', text: `Benchmark authorization ${n} for an offline fixture scope`, sourceMessageId: String(n), grant: { action: 'push', scope: `fixture/${n}`, allow: true, until: 'done' } }
      : { kind: n % 2 ? 'decision' : 'constraint', text: `Benchmark decision ${n}: keep the fixture offline; no provider calls, no production writes, cite the source line ${n} for every claim.`, sourceMessageId: String(n) });
  }
  return dir;
}

interface Fixture { model: Model<Api>; sawRequest(): number | undefined; startRequest(): void }
/** A headless Pi with the fixture provider; `firstRequest` is when the first provider call of the current turn arrived. */
async function openSession(root: string, notes: string[]): Promise<{ session: Awaited<ReturnType<typeof createAgentSession>>['session']; fixture: Fixture; close(): Promise<void> }> {
  const dir = join(root, 'pi');
  mkdirSync(dir, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  let requested: number | undefined;
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: CONTEXT_WINDOW, maxTokens: 16_000 }],
    streamSimple(model, context) {
      const last = context.messages.at(-1);
      // Summaries built in the background are provider calls too; only a turn's own request marks the turn's provider time.
      if (!JSON.stringify(last && 'content' in last ? last.content : '').includes('Compaction: ')) requested ??= performance.now();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `OK: ${textContent(last && 'content' in last ? last.content : '').slice(0, 40)}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  const model = runtime.getModel('fixture', 'fixture');
  const { session } = await createAgentSession({ modelRuntime: runtime, model, resourceLoader: loader, settingsManager, sessionManager: manager });
  session.extensionRunner.setFlagValue('optchat-profile', PROFILE);
  session.extensionRunner.setFlagValue('optchat-connect', 'off');
  const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), notify: message => { notes.push(message); }, select: async () => { throw new Error('the benchmark must not ask for a profile'); } };
  const errors: unknown[] = [];
  await session.bindExtensions({ uiContext, mode: 'print', onError: error => { errors.push(error.error); } });
  const close = async () => {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    if (errors.length) throw new Error(`extension errors: ${errors.map(String).join('; ')}`);
  };
  return { session, fixture: { model, sawRequest: () => requested, startRequest: () => { requested = undefined; } }, close };
}

const percentile = (sorted: readonly number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50Ms: round(percentile(sorted, 0.5)), p95Ms: round(percentile(sorted, 0.95)), maxMs: round(sorted.at(-1) ?? 0) };
};
const round = (ms: number) => Math.round(ms * 100) / 100;

interface Stage { count: number; totalMs: number; maxMs: number; lastMs: number; p50Ms?: number; p95Ms?: number }
async function readMetrics(session: Awaited<ReturnType<typeof openSession>>['session'], notes: string[]): Promise<{ stages: Record<string, Stage>; request: unknown }> {
  await session.prompt('/optchat-perf');
  const note = notes.at(-1);
  if (!note) throw new Error('/optchat-perf printed nothing');
  const report = JSON.parse(note) as { stages: Record<string, Stage>; request: unknown };
  return { stages: report.stages, request: report.request };
}

export async function runTurnStartBenchmark(options: { messages: number; turns: number; warmup: number; gapMs?: number; cpuProfile?: string }) {
  // support.ts sandboxes OPTCHAT_HOME and PI_CODING_AGENT_DIR into a temp root that is removed at exit.
  const root = mkdtempSync(join(tmpdir(), 'turn-start-'));
  process.env.OPTCHAT_HOME = join(root, 'optchat');
  mkdirSync(process.env.OPTCHAT_HOME, { recursive: true });
  const setup = performance.now();
  await createFixtureProfile(options.messages);
  const fixtureMs = performance.now() - setup;
  const notes: string[] = [];
  const { session, fixture, close } = await openSession(root, notes);
  let profiler: Profiler | undefined;
  try {
    rememberProfile(PROFILE);
    if (options.cpuProfile) profiler = await startProfiler();
    const wall: number[] = [], beforeProvider: number[] = [], afterProvider: number[] = [];
    for (let turn = 0; turn < options.warmup + options.turns; turn++) {
      if (turn > 0 && options.gapMs) await new Promise(resolve => setTimeout(resolve, options.gapMs));
      fixture.startRequest();
      const started = performance.now();
      await session.prompt(`Benchmark turn ${turn}: report the status of work item ${turn % 7} in one line.`);
      const ended = performance.now(), sent = fixture.sawRequest();
      if (turn < options.warmup) continue;
      wall.push(ended - started);
      if (sent !== undefined) { beforeProvider.push(sent - started); afterProvider.push(ended - sent); }
    }
    if (profiler && options.cpuProfile) await profiler.stop(options.cpuProfile);
    const metrics = await readMetrics(session, notes);
    return { fixtureMessages: options.messages, fixtureMs: round(fixtureMs), turns: options.turns, warmup: options.warmup, gapMs: options.gapMs ?? 0,
      promptToProvider: summary(beforeProvider), providerToSettled: summary(afterProvider), wholeTurn: summary(wall),
      stages: metrics.stages, request: metrics.request };
  } finally { await close(); }
}

/** A CPU profile of the measured turns only, so the fixture's own writes stay out of it. */
interface Profiler { stop(file: string): Promise<void> }
async function startProfiler(): Promise<Profiler> {
  const session = new InspectorSession();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 200 });
  await session.post('Profiler.start');
  return { async stop(file) { const { profile } = await session.post('Profiler.stop'); writeFileSync(file, JSON.stringify(profile)); session.disconnect(); } };
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/turn-start-benchmark.ts')) {
  const arg = (name: string, fallback: number) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
  const cpuProfile = process.argv.find(a => a.startsWith('--cpu-profile='))?.slice('--cpu-profile='.length);
  const result = await runTurnStartBenchmark({ messages: arg('messages', 20_000), turns: arg('turns', 40), warmup: arg('warmup', 5), gapMs: arg('gap', 0), cpuProfile });
  console.log(JSON.stringify(result, null, 2));
}
