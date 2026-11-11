// Disposable heap and stall bench for the whole OptChat extension.
//
//   node --experimental-transform-types --expose-gc --max-old-space-size=4096 scripts/heap-bench.ts \
//     --source <profile dir, read only> [--profile swlucas05] [--workers 20] [--turns 500] [--json out.json]
//
// Isolation (scripts/bench-sandbox.ts): the bench builds its OWN OPTCHAT_HOME under the temp dir from an allowlist of the
// source profile's data (memory, runs, usage), with a fresh config on an offline fixture model; assistant.json and every
// other live-service file stay behind, the sandbox guard refuses to start when one is present or the home is the real one,
// and global fetch is blocked, so nothing can reach the assistant service, Slack, ai-memory or the network.
// Every phase forces two collections, then prints heap, RSS and the longest event-loop gap since the previous phase.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { assertSandbox, blockNetwork, copyProfile } from './bench-sandbox.ts';

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const source = arg('source'), profile = arg('profile', 'swlucas05')!, workers = Number(arg('workers', '20')), turns = Number(arg('turns', '500'));
if (!source) throw new Error('--source <profile directory to copy from> is required');
if (typeof globalThis.gc !== 'function') throw new Error('run with --expose-gc');
const scratch = mkdtempSync(join(tmpdir(), 'heap-bench-'));
const home = join(scratch, 'home');
process.env.OPTCHAT_HOME = home;
process.env.PI_CODING_AGENT_DIR = join(scratch, 'agent');
process.env.AI_MEMORY_SERVER_URL = 'http://127.0.0.1:9'; process.env.AI_MEMORY_DATA_DIR = join(scratch, 'ai-memory');
process.env.PI_GITWATCH_DIR = join(scratch, 'gitwatch'); process.env.MEMORY_DIR = join(scratch, 'optmem');
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
blockNetwork();

const { default: optchat } = await import('../src/index.ts');
const { createProfile, loadConfig, profilePath, saveConfig } = await import('../src/profiles.ts');
const { textContent } = await import('../src/transcript.ts');
const { emptyUsage } = await import('../src/usage.ts');

// A fresh profile (default settings, nothing that talks to a service) on an offline fixture model, then the source's data on top.
createProfile(profile);
const fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' } as const;
saveConfig(profilePath(profile), { ...loadConfig(profilePath(profile)), compactor: fixture, subagent: fixture, heartbeatMinutes: 0, syncStatus: false, syncAiMemory: false, syncOptMem: false });
copyProfile(source, home, profile);
assertSandbox(home);
console.log(`sandbox ok: home=${home}`);

const big = join(scratch, 'big.txt');
writeFileSync(big, Array.from({ length: 1500 }, (_, i) => `line ${i} ${'lorem ipsum dolor sit amet '.repeat(2)}`).join('\n'));

const mb = (n: number) => Math.round(n / 104857.6) / 10;
const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
let gap = 0, last = performance.now();
const probe = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last - 20); last = now; }, 20);
const rows: Record<string, unknown>[] = [];
function sample(label: string) {
  globalThis.gc!(); globalThis.gc!();
  const m = process.memoryUsage(), v8 = process.getBuiltinModule('node:v8'), spaces = Object.fromEntries(v8.getHeapSpaceStatistics().map(s => [s.space_name, mb(s.space_used_size)]));
  const row = { label, heapMB: mb(m.heapUsed), rssMB: mb(m.rss), externalMB: mb(m.external), oldSpaceMB: spaces.old_space, maxGapMs: Math.round(gap), p99Ms: Math.round(delay.percentile(99) / 1e6) };
  rows.push(row); gap = 0; delay.reset(); last = performance.now();
  console.log(Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' '));
}

let calls = 0;
function stream(model: Model<Api>, context: Context) {
  const last = context.messages.at(-1), prompt = textContent(last && 'content' in last ? last.content : '');
  const compacting = prompt.includes('\n\nCompaction:'), worker = context.messages.some(m => m.role === 'user' && textContent(m.content).includes('Your task:'));
  const toolResults = context.messages.filter(m => m.role === 'toolResult').length;
  const wantsRead = !compacting && (worker ? toolResults < 3 : /^read /.test(prompt) && last?.role === 'user');
  const spawns = !compacting && /^spawn worker/.test(prompt) && last?.role === 'user';
  const content: AssistantMessage['content'] = spawns ? [{ type: 'toolCall', id: `s-${++calls}`, name: 'spawn', arguments: { tasks: [{ task: `Read the file ${big} and report. ${prompt}` }] } }]
    : compacting ? [{ type: 'text', text: `talk: summary ${++calls} ${'compacted '.repeat(30)}` }]
    : wantsRead ? [{ type: 'toolCall', id: `r-${++calls}`, name: 'read', arguments: { path: big } }]
    : [{ type: 'text', text: worker ? `worker done ${'report '.repeat(40)}` : `OK ${prompt.slice(0, 80)}` }];
  const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: wantsRead || spawns ? 'toolUse' : 'stop', usage: emptyUsage() };
  const out = createAssistantMessageEventStream();
  queueMicrotask(() => { out.push({ type: 'start', partial: message }); out.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); out.end(); });
  return out;
}

const dir = mkdtempSync(join(scratch, 's-'));
const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
  models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  streamSimple: stream });
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true,
  noPromptTemplates: true, extensionFactories: [optchat] });
await loader.reload();
sample('baseline (before open)');
const manager = SessionManager.create(dir, join(dir, 'sessions'));
manager.appendCustomEntry('optchat.profile', { name: profile });
const opened = performance.now();
const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager });
const errors: string[] = [];
session.extensionRunner.setFlagValue('optchat-profile', profile);
session.extensionRunner.setFlagValue('optchat-connect', 'off');
const ui: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), notify: () => {}, select: async () => { throw new Error('no picker'); } };
await session.bindExtensions({ uiContext: ui, mode: 'rpc', onError: error => { errors.push(error.error); } });
console.log(`open ms=${Math.round(performance.now() - opened)}`);
sample('after open');

const heap = async () => {
  const tool = session.getAllTools().find(t => t.name === 'heap_report');
  return tool;
};
void heap;

const ask = (text: string) => session.prompt(text);
const runsDir = join(profilePath(profile), 'runs');
const finished = () => readdirSync(runsDir).filter(f => f.endsWith('.optchat.json')).flatMap(f => {
  try { const run = JSON.parse(readFileSync(join(runsDir, f), 'utf8')) as { state: string; started: number }; return run.started >= start ? [run] : []; } catch { return []; }
});
const start = Date.now();

// Phase A: chat turns that read a file and answer, so memory appends and compacts, as in a day of use.
const per = Math.max(1, Math.floor(turns / 5));
let n = 0;
for (let round = 1; round <= 5; round++) {
  for (let i = 0; i < per; i++) { await ask(`${i % 3 === 0 ? 'read ' : ''}turn ${++n} ${'filler '.repeat(60)}`); }
  await session.agent.waitForIdle();
  sample(`after ${n} chat turns`);
}

// Phase B: workers, each reading a file a few times, then reporting to the parent.
const done = () => finished().filter(r => !['running', 'waiting', 'stopping'].includes(r.state)).length;
for (let w = 1; w <= workers; w += 1) {
  const before = done();
  await ask(`spawn worker ${w}`).catch(error => errors.push(String(error)));
  const deadline = Date.now() + 60_000;
  while (done() <= before && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  await session.agent.waitForIdle();
  if (w % 5 === 0) sample(`after ${w} workers`);
}
sample('final');
if (errors.length) console.log('errors', errors.slice(0, 5));
const out = arg('json');
if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
clearInterval(probe);
await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
process.exit(0);
