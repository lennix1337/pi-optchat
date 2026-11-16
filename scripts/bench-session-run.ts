// Loaded by bench-session.mjs only, after it pins Pi's module resolution.
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { writeHeapSnapshot } from 'node:v8';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { assertSandbox, blockNetwork, copyProfile, COPIED } from './bench-sandbox.ts';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
const source = arg('source'), sessionFile = arg('session'), out = arg('json'), snapshotDir = arg('snapshots');
const turns = Number(arg('turns') ?? 100);
if (!source || !sessionFile || !Number.isSafeInteger(turns) || turns < 1) throw new Error('--source, --session and a positive --turns are required');
if (!globalThis.gc) throw new Error('run with --expose-gc');
// Never follow a copied link back into live data. Reject the real homes even when supplied through a junction.
const inside = (parent: string, child: string) => { const p = relative(parent, child); return p === '' || (!p.startsWith('..') && !isAbsolute(p)); };
const realHome = realpathSync(join(process.env.USERPROFILE ?? homedir(), '.optchat'));
const agentHome = realpathSync(join(process.env.USERPROFILE ?? homedir(), '.pi', 'agent'));
for (const input of [source, sessionFile]) {
  const actual = realpathSync(input);
  if (inside(realHome, actual) || inside(actual, realHome) || inside(agentHome, actual) || inside(actual, agentHome)) throw new Error('input must be a copy, not a live OptChat or Pi file');
}
for (const output of [out, snapshotDir]) if (output) {
  const actual = join(realpathSync(dirname(resolve(output))), basename(output));
  if ([realHome, agentHome, realpathSync(source)].some(root => inside(root, actual))) throw new Error('output must not be inside a live home or the copied input');
}
const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
function fingerprint(path: string, key: string) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error('input contains a symbolic link; copy its contents first');
  hash.update(key); hash.update('\0');
  if (info.isDirectory()) { for (const name of readdirSync(path).sort()) fingerprint(join(path, name), `${key}/${name}`); return; }
  if (!info.isFile()) throw new Error('input contains a non-regular file');
  hash.update(String(info.size)); hash.update('\0');
  const fd = openSync(path, 'r'); try { let n: number; while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n)); } finally { closeSync(fd); }
}
for (const name of [...COPIED, 'child-usage-counted.json']) { try { statSync(join(source, name)); } catch { if (name === 'child-usage-counted.json') throw new Error('copied child-usage-counted.json is required'); continue; } fingerprint(join(source, name), name); }
fingerprint(sessionFile, 'session');
const inputSha256 = hash.digest('hex');

const scratch = mkdtempSync(join(tmpdir(), 'optchat-session-bench-')), home = join(scratch, 'home');
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* disposable scratch may be left for manual cleanup */ } });
process.env.OPTCHAT_HOME = home; process.env.OPTCHAT_EFFECT_APPROVALS = '0';
process.env.PI_CODING_AGENT_DIR = join(scratch, 'agent'); process.env.AI_MEMORY_SERVER_URL = 'http://127.0.0.1:9';
process.env.AI_MEMORY_DATA_DIR = join(scratch, 'ai-memory'); process.env.PI_GITWATCH_DIR = join(scratch, 'gitwatch'); process.env.MEMORY_DIR = join(scratch, 'optmem');
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true }); blockNetwork();
const { default: optchat } = await import('../src/index.ts');
const { createProfile, loadConfig, profilePath, saveConfig } = await import('../src/profiles.ts');
const { emptyUsage } = await import('../src/usage.ts');
const profile = 'bench'; createProfile(profile);
const fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' } as const;
saveConfig(profilePath(profile), { ...loadConfig(profilePath(profile)), compactor: fixture, subagent: fixture, heartbeatMinutes: 0, machineLower: false, syncStatus: false, syncAiMemory: false, syncOptMem: false });
copyProfile(source, home, profile);
copyFileSync(join(source, 'child-usage-counted.json'), join(profilePath(profile), 'child-usage-counted.json'));
const runs = join(profilePath(profile), 'runs');
for (const name of readdirSync(runs)) if (name.endsWith('.optchat.json')) {
  const path = join(runs, name), record = JSON.parse(readFileSync(path, 'utf8'));
  if (!record.sessionFile) continue;
  const local = join(runs, basename(record.sessionFile));
  if (!statSync(local).isFile()) throw new Error('a copied child session is missing');
  record.sessionFile = local; writeFileSync(path, JSON.stringify(record));
}
assertSandbox(home);
const big = join(scratch, 'fixture.txt');
writeFileSync(big, Array.from({ length: 1500 }, (_, i) => `line ${i} ${'lorem ipsum dolor sit amet '.repeat(2)}`).join('\n'));
let calls = 0;
function stream(model: Model<Api>, context: Context) {
  const last = context.messages.at(-1);
  // OptChat can append a status user message after the actual prompt. Match the task's own text block, not the final message
  // or a word in the memory view; compactor requests also use this fixture model.
  const task = context.messages.findLast(message => message.role === 'user' && (typeof message.content === 'string'
    ? /^\s*BENCH_TASK_/.test(message.content)
    : message.content.some(block => block.type === 'text' && /^\s*BENCH_TASK_/.test(block.text))));
  const blocks = task?.role === 'user' ? (typeof task.content === 'string' ? [task.content] : task.content.flatMap(b => b.type === 'text' ? [b.text] : [])) : [];
  const action = blocks.find(text => /^\s*BENCH_TASK_/.test(text))?.trim() ?? '';
  const read = action.startsWith('BENCH_TASK_READ ') && last?.role !== 'toolResult';
  const bash = action === 'BENCH_TASK_BASH' && last?.role !== 'toolResult';
  const content: AssistantMessage['content'] = bash ? [{ type: 'toolCall', id: `b-${++calls}`, name: 'bash', arguments: { command: 'printf fixture' } }]
    : read ? [{ type: 'toolCall', id: `r-${++calls}`, name: 'read', arguments: { path: big } }]
    : [{ type: 'text', text: 'fixture response' }];
  const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: read || bash ? 'toolUse' : 'stop', usage: emptyUsage() };
  const result = createAssistantMessageEventStream();
  queueMicrotask(() => { result.push({ type: 'start', partial: message }); result.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); result.end(); });
  return result;
}
const dir = join(scratch, 'session'); mkdirSync(dir);
const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
  models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }], streamSimple: stream });
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
const executed: { name: string; failed: boolean }[] = [];
const observe = (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) => pi.on('tool_execution_end', event => { executed.push({ name: event.toolName, failed: event.isError }); });
const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat, observe] });
await loader.reload();
const copiedSession = join(dir, 'session.jsonl'); copyFileSync(sessionFile, copiedSession);
const mb = (bytes: number) => Math.round(bytes / 104857.6) / 10;
const memory = () => { globalThis.gc!(); globalThis.gc!(); const m = process.memoryUsage(); return { heapMiB: mb(m.heapUsed), rssMiB: mb(m.rss), externalMiB: mb(m.external) }; };
const beforeOpen = memory();
const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable(); await delay(15); histogram.reset();
const start = performance.now();
const manager = SessionManager.open(copiedSession); manager.appendCustomEntry('optchat.profile', { name: profile });
const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager });
session.extensionRunner.setFlagValue('optchat-profile', profile); session.extensionRunner.setFlagValue('optchat-connect', 'off');
const errors: string[] = [];
const notices: string[] = [];
const ui: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), notify: text => { notices.push(text); }, select: async () => { throw new Error('no picker in benchmark'); } };
// Print mode intentionally excludes live machine/process sampling and service integrations.
await session.bindExtensions({ uiContext: ui, mode: 'print', onError: error => { errors.push(error.error); } });
await session.waitForIdle(); const openMs = performance.now() - start;
await delay(15); const openMaxIntervalMs = histogram.max / 1e6, openP99IntervalMs = histogram.percentile(99) / 1e6;
const initial = memory();
if (snapshotDir) { mkdirSync(snapshotDir); writeHeapSnapshot(join(snapshotDir, 'early.heapsnapshot')); }
await delay(15);
async function measure(text: string) {
  await session.waitForIdle(); histogram.reset(); const before = performance.now();
  let preflight: string | undefined;
  await session.prompt(text, { preflightResult: result => { preflight = result; } }); await session.waitForIdle();
  if (preflight !== 'started') throw new Error(`benchmark prompt did not start (${preflight}): ${JSON.stringify(notices.slice(-3))}`);
  const wallMs = performance.now() - before;
  await delay(15); return { wallMs, maxIntervalMs: histogram.max / 1e6, p99IntervalMs: histogram.percentile(99) / 1e6 };
}
const rows = [];
for (let i = 1; i <= turns; i++) rows.push(await measure(`BENCH_TASK_${i % 3 === 1 ? 'READ' : 'CHAT'} turn ${i} ${'filler '.repeat(60)}`));
const bash = await measure('BENCH_TASK_BASH'), final = memory();
if (snapshotDir) writeHeapSnapshot(join(snapshotDir, 'late.heapsnapshot'));
histogram.disable();
await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
if (errors.length) throw new Error(`extension errors: ${errors.join('; ')}`);
if (executed.filter(item => item.name === 'bash' && !item.failed).length !== 1 || executed.filter(item => item.name === 'read' && !item.failed).length !== Math.ceil(turns / 3)) throw new Error(`fixture tools did not all finish successfully: ${JSON.stringify(executed)}`);
const result = { inputSha256, piRelease: basename(resolve(process.env.PI_BENCH_RELEASE!)), node: process.version, turns, copiedSessionEntries: manager.getEntries().length,
  mode: 'print, offline fixture; compaction disabled', openMs, openMaxIntervalMs, openP99IntervalMs, beforeOpen, initial, final, bash,
  maxTurnIntervalMs: Math.max(...rows.map(r => r.maxIntervalMs)), turnsData: rows };
if (out) writeFileSync(out, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...result, turnsData: undefined }));
rmSync(scratch, { recursive: true, force: true });
