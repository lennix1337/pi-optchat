// Risk-mode gate in the real installed SDK with the real bash tool: a disposable local push
// is blocked, then authorized once by an interactive token; ordinary commands run ungated.
// Scripted provider, network rejected, no external model requests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';

const version = readFileSync(join(homedir(), '.pi/agent/install/current-version'), 'utf8').trim();
const sdkRoot = join(homedir(), '.pi/agent/install/releases', version, 'node_modules/@earendil-works');
const scratch = mkdtempSync(join(tmpdir(), 'effect-risk-runtime-'));
const agent = join(scratch, 'agent');
const repo = join(scratch, 'repo');
const remote = join(scratch, 'remote.git');
mkdirSync(agent);
const git = (...args) => execFileSync('git', args, { cwd: scratch, encoding: 'utf8' }).trim();
git('init', '-q', '--bare', remote);
git('init', '-q', '-b', 'main', repo);
writeFileSync(join(repo, 'a.txt'), 'a');
git('-C', repo, '-c', 'user.name=probe', '-c', 'user.email=probe@local', 'commit', '-q', '--allow-empty', '-m', 'probe');
git('-C', repo, 'remote', 'add', 'origin', remote);
const remoteHead = () => { try { return git('--git-dir', remote, 'rev-parse', '--verify', '-q', 'main'); } catch { return undefined; } };

for (const key of Object.keys(process.env)) if (/TOKEN|API_KEY|SECRET|PASSWORD/i.test(key)) delete process.env[key];
process.env.PI_CODING_AGENT_DIR = agent;
process.env.OPTCHAT_EFFECT_APPROVALS = 'risk';
let networkAttempts = 0;
function offline(boundary) { networkAttempts++; throw new Error(`Offline risk probe forbids ${boundary}`); }
globalThis.fetch = async () => offline('fetch');
net.Socket.prototype.connect = () => offline('socket');
const sdk = await import(pathToFileURL(join(sdkRoot, 'pi-coding-agent/dist/index.js')).href);
const ai = await import(pathToFileURL(join(sdkRoot, 'pi-ai/dist/index.js')).href);
const runtime = await sdk.ModelRuntime.create({ authPath: join(agent, 'auth.json'), modelsPath: null, modelsStorePath: join(agent, 'models.json'), refreshOnCreate: false });
let command = '';
let calls = 0;
const results = [];
const errors = [];
runtime.registerProvider('risk-fixture', {
  api: 'openai-completions', apiKey: 'offline', baseUrl: 'https://invalid.local',
  models: [{ id: 'fixture', name: 'Offline risk fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  streamSimple(model, context) {
    const content = context.messages.at(-1).role === 'toolResult'
      ? [{ type: 'text', text: 'fixture-observed' }]
      : [{ type: 'toolCall', id: `risk-${++calls}`, name: 'bash', arguments: { command } }];
    const stopReason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
    const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = ai.createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); });
    return stream;
  },
});
const settingsManager = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
const loader = new sdk.DefaultResourceLoader({ cwd: repo, agentDir: agent, settingsManager,
  noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, disabledBuiltinExtensions: ['mcp', 'codemode'],
  extensionFactories: [pi => registerEffectApprovals(pi)] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await sdk.createAgentSession({ cwd: repo, agentDir: agent, modelRuntime: runtime, model: runtime.getModel('risk-fixture', 'fixture'),
  settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.create(repo, join(scratch, 'sessions')), tools: ['bash'] });
const attempt = async text => { command = text; await session.prompt(`Run: ${text}`); return results.at(-1); };
try {
  await session.bindExtensions({ mode: 'print', onError: event => errors.push(event.error) });
  session.subscribe(event => { if (event.type === 'tool_execution_end') results.push({ isError: event.isError, text: JSON.stringify(event.result.content) }); });
  const push = `git -C ${repo.replaceAll('\\', '/')} push -q origin main`;
  const ordinary = await attempt('git status --short && echo ordinary-ran > ordinary.txt');
  assert.equal(readFileSync(join(repo, 'ordinary.txt'), 'utf8').trim(), 'ordinary-ran', 'ordinary command runs without a token');
  assert.doesNotMatch(ordinary.text, /approve-effect/);
  const blocked = await attempt(push);
  assert.match(blocked.text, /is a push effect and requires approval/);
  assert.equal(remoteHead(), undefined, 'blocked push did not reach the remote');
  const token = /approve-effect ([a-f0-9]{24})/.exec(blocked.text)[1];
  await session.prompt(`approve-effect ${token}`, { source: 'interactive' });
  assert.equal(remoteHead(), git('-C', repo, 'rev-parse', 'main'), 'authorized push reached the disposable remote');
  const replay = await attempt(push);
  assert.match(replay.text, /requires approval/, 'the token is single-use');
  assert.equal(networkAttempts, 0); assert.deepEqual(errors, []);
  const report = { passed: true, sdk: version, node: process.version, mode: 'risk', ordinaryRan: true, pushBlocked: true, pushAuthorizedOnce: true, replayBlocked: true, networkAttempts, externalModelRequests: 0,
    limitations: 'Scripted provider and a disposable local remote; not the operator\'s interactive profile, and risk classes are a guardrail, not a shell sandbox.' };
  writeFileSync(join(scratch, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}
