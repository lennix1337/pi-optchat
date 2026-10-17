import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { ContainerModelBridge, jsonLines, type BridgeReply } from './optchat-model-bridge.ts';

export type ContainerAgentConfig = { kind: 'start'; model: Model<Api>; prompt: string; thinking: 'high' | 'off'; cwd: string; capturePatch?: boolean };

/** Runs inside an isolated container. Its only external capability is a model-event pipe. */
export async function runContainerAgent(config: ContainerAgentConfig, bridge: ContainerModelBridge, send: (message: unknown) => void) {
  const home = process.env.OPTCHAT_HOME;
  if (!home || !process.env.PI_CODING_AGENT_DIR) throw new Error('Isolated OptChat and Pi homes are required.');
  const cwd = resolve(config.cwd);
  await mkdir(cwd, { recursive: true });
  let baseCommit: string | undefined;
  if (config.capturePatch) {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
    baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    if (status.trim() || !/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error('Task checkout is not a clean pinned baseline.');
  }
  const runtime = await ModelRuntime.create({ authPath: join(home, 'no-auth.json'), modelsPath: null,
    modelsStorePath: join(home, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
  // Never import provider headers, credentials, or remote configuration from the host.
  const model = config.model;
  runtime.registerProvider(model.provider, { baseUrl: 'https://invalid.local', apiKey: 'pipe-only', api: model.api,
    models: [{ id: model.id, name: model.name, reasoning: model.reasoning, input: model.input, cost: model.cost,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens }], streamSimple: (m, context, options) => bridge.stream(m, context, options) });
  createProfile('benchmark');
  const dir = profilePath('benchmark');
  const choice = { provider: model.provider, model: model.id, thinking: config.thinking };
  saveConfig(dir, { ...loadConfig(dir), compactor: choice, subagent: choice, syncStatus: false, syncOptMem: false });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings,
    noExtensions: true, noContextFiles: !config.capturePatch, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(cwd, join(home, 'sessions'));
  const { session } = await createAgentSession({ cwd, modelRuntime: runtime, model: runtime.getModel(model.provider, model.id),
    thinkingLevel: config.thinking, resourceLoader: loader, settingsManager: settings, sessionManager: manager });
  session.extensionRunner.setFlagValue('optchat-profile', 'benchmark');
  session.extensionRunner.setFlagValue('optchat-connect', 'off');
  const errors: string[] = [];
  try {
    await session.bindExtensions({ mode: 'rpc', onError: error => { errors.push(error.error); } });
    const bound = manager.getEntries().some(entry => entry.type === 'custom' && entry.customType === 'optchat.profile');
    const tools = session.getActiveToolNames();
    if (!bound || !['zoom', 'date', 'output_read', 'shell_start'].every(name => tools.includes(name))) throw new Error('OptChat harness is not active.');
    send({ kind: 'ready', bound, tools, thinking: session.thinkingLevel, provider: model.provider, model: model.id, baseCommit });
    await session.prompt(config.prompt);
    if (errors.length) throw new Error('OptChat extension reported an error.');
    const messages = session.state.messages;
    const last = messages.at(-1);
    if (last?.role !== 'assistant' || last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error('No successful final model response.');
    if (config.capturePatch) execFileSync('git', ['add', '-N', '--', '.'], { cwd });
    const patch = config.capturePatch ? execFileSync('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 }) : undefined;
    const gitStatus = config.capturePatch ? execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }) : undefined;
    send({ kind: 'result', messages, patch, gitStatus, errors });
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    bridge.close();
  }
}

async function main() {
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const bridge = new ContainerModelBridge(send);
  let started = false;
  const lines = jsonLines(process.stdin, message => {
    const value = message as { kind?: string };
    if (value.kind === 'start' && !started) {
      started = true;
      void runContainerAgent(message as ContainerAgentConfig, bridge, send)
        .catch(() => { send({ kind: 'fatal', message: 'Container OptChat session failed; no retry.' }); process.exitCode = 1; })
        .finally(() => { lines.close(); process.stdin.destroy(); });
    } else if (value.kind === 'event' || value.kind === 'failure') bridge.receive(message as BridgeReply);
    else throw new Error('Invalid container model protocol.');
  }, () => { bridge.close(); process.exitCode = 1; process.stdin.destroy(); });
  lines.on('close', () => bridge.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
