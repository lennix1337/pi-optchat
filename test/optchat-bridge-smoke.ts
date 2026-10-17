import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { freemem, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { runTransport } from './optchat-container-transport.ts';
// @ts-expect-error JavaScript staging helper also tested independently.
import { assertSmokeGate, smokeArgs, stageContext } from './optchat-container-smoke.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.argv.slice(2);
if (cli.length && (cli.length !== 2 || cli[0] !== '--task-image' || !/^swebench\/sweb\.eval\.x86_64\.[a-z0-9_.-]+:latest$/.test(cli[1]))) {
  throw new Error('Use no arguments, or --task-image with an official SWE-bench image.');
}
const taskImage = cli[1];
const docker = (args: string[], timeout = 30_000) => execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 ** 2 });
// This is functional acceptance with a fixture provider, never an inference/performance benchmark.
assertSmokeGate('', freemem());
const existingContainers = docker(['ps', '-q']).trim().split('\n').filter(Boolean);
const context = await mkdtemp(join(tmpdir(), 'oc-bridge-build-'));
const name = `optchat-smoke-${randomUUID()}`, image = `${name}:local`;
const model: Model<Api> = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'https://invalid.local',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const contexts: string[] = [];
let isolation: unknown;
let report: unknown;
let compactionRequests = 0;
try {
  stageContext(repo, context);
  if (taskImage) {
    // Reuse the actual task environment, adding only the sandboxed Node/OptChat runtime.
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(join(context, 'Dockerfile'), 'utf8');
    await writeFile(join(context, 'Dockerfile'), original.replace('FROM node:22-slim', 'FROM node:22-slim AS runtime')
      + `\nFROM ${taskImage}\nCOPY --from=runtime /usr/local/bin/node /usr/local/bin/node\nCOPY --from=runtime /app /app\nENV HOME=/tmp/home PI_CODING_AGENT_DIR=/tmp/agent OPTCHAT_HOME=/tmp/optchat\n`);
  }
  docker(['build', '--tag', image, context], 600_000);
  const args = [...smokeArgs(image, name).slice(0, -1), '--interactive', '--entrypoint', 'node', image,
    '--import', '/app/node_modules/tsx/dist/loader.mjs', '/app/test/optchat-container-agent.ts'];
  report = await runTransport('docker', args, { kind: 'start', model, cwd: '/tmp/work', thinking: 'off',
    prompt: 'Write bridge-probe.txt containing isolated OptChat, then read it back and confirm.' }, async function* (ctx) {
    if (!isolation) {
      const inspected = JSON.parse(docker(['inspect', name]))[0];
      const host = inspected.HostConfig;
      assert.equal(host.NetworkMode, 'none');
      assert.equal(host.ReadonlyRootfs, true);
      assert.equal(host.Memory, 4 * 1024 ** 3);
      assert.equal(host.MemorySwap, 4 * 1024 ** 3);
      assert.equal(host.NanoCpus, 4 * 1e9);
      assert.equal(inspected.Mounts.length, 0);
      assert.ok(host.CapDrop.includes('ALL'));
      isolation = { network: host.NetworkMode, readOnly: host.ReadonlyRootfs, memory: host.Memory, cpus: host.NanoCpus, hostMounts: 0 };
    }
    const last = ctx.messages.at(-1);
    if (last && textContent(last.content).includes('\n\nCompaction:')) {
      compactionRequests++;
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'echo: Tool output retained; use zoom for the original.' }],
        stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
      yield { type: 'done', reason: 'stop', message };
      return;
    }
    contexts.push(JSON.stringify(ctx));
    let content: AssistantMessage['content'];
    if (contexts.length === 1) content = [{ type: 'toolCall', id: 'write-fixture', name: 'write', arguments: { path: 'bridge-probe.txt', content: 'isolated OptChat' } }];
    else if (contexts.length === 2) content = [{ type: 'toolCall', id: 'read-fixture', name: 'read', arguments: { path: 'bridge-probe.txt' } }];
    else if (contexts.length === 3) content = [{ type: 'toolCall', id: 'log-fixture', name: 'bash', arguments: {
      command: "for i in $(seq 1 1500); do printf 'unit %04d unchanged settings\\n' \"$i\"; done; printf 'ERROR RAW_FINAL_SENTINEL exit code 7\\n'; exit 7" } }];
    else if (contexts.length === 4) {
      await writeFile(join(repo, 'scratchpad/optchat-bridge-log-context.json'), JSON.stringify(ctx, null, 2));
      const saved = contexts[3].match(/output:([a-f0-9]{64})/);
      assert.ok(saved, 'real OptChat must project large shell output, not just pass the SDK tool result through');
      content = [{ type: 'toolCall', id: 'retrieve-fixture', name: 'output_read', arguments: { ref: saved[1], findText: 'RAW_FINAL_SENTINEL' } }];
    } else if (contexts.length === 5) content = [{ type: 'toolCall', id: 'inspect-log-operation', name: 'operation_state', arguments: {} }];
    else if (contexts.length === 6) {
      const inspection = ctx.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'operation_state');
      assert.ok(inspection && 'content' in inspection);
      const pending = JSON.parse(textContent(inspection.content)).uncertain;
      assert.equal(pending.length, 1);
      content = [{ type: 'toolCall', id: 'reconcile-log-operation', name: 'operation_state', arguments: { id: pending[0].id,
        evidence: 'Independent output_read original-log search observed RAW_FINAL_SENTINEL and exit code 7. No filesystem mutation claimed or repeated.' } }];
    }
    else if (contexts.length === 7) content = [{ type: 'toolCall', id: 'missing-rg', name: 'bash', arguments: { command: 'rg -n "class CharField|MaxLengthValidator" missing-diagnostic-input' } }];
    else if (contexts.length === 8) content = [{ type: 'toolCall', id: 'missing-grep', name: 'bash', arguments: { command: "grep -n -E 'class CharField|MaxLengthValidator' missing-diagnostic-input" } }];
    else if (contexts.length === 9) content = [{ type: 'toolCall', id: 'edit-after-diagnostic', name: 'edit', arguments: { path: 'bridge-probe.txt', edits: [{ oldText: 'isolated OptChat', newText: 'verified diagnostic recovery' }] } }];
    else if (contexts.length === 10) content = [{ type: 'toolCall', id: 'verify-edit', name: 'read', arguments: { path: 'bridge-probe.txt' } }];
    else content = [{ type: 'text', text: 'confirmed' }];
    const reason = contexts.length < 11 ? 'toolUse' : 'stop';
    const message: AssistantMessage = { role: 'assistant', content, stopReason: reason, api: model.api, provider: model.provider,
      model: model.id, timestamp: Date.now(), usage: emptyUsage() };
    yield { type: 'start', partial: message };
    yield { type: 'done', reason, message };
  });
  assert.equal(contexts.length, 11);
  assert.match(contexts[0], /You are OptChat/);
  assert.match(contexts[1], /toolResult/);
  assert.match(contexts[2], /isolated OptChat/);
  assert.match(contexts[4], /RAW_FINAL_SENTINEL/);
  assert.match(contexts[10], /verified diagnostic recovery/);
  assert.doesNotMatch(contexts[10], /External outcome uncertain/);
} finally {
  try { docker(['rm', '--force', name]); } finally {
    try { docker(['image', 'rm', image]); } finally { await rm(context, { recursive: true, force: true }); }
  }
}
const remaining = docker(['ps', '-q']).trim().split('\n').filter(Boolean);
for (const id of existingContainers) assert.ok(remaining.includes(id), 'existing service must remain running');
assert.ok(!remaining.some(id => id === name));
const result = { scope: 'offline functional acceptance, shared host, synthetic provider; not benchmark or paid inference',
  taskImage: taskImage ?? null, isolation, compactionRequests, toolRoundTrips: 10, existingContainersPreserved: existingContainers.length, report };
await writeFile(join(repo, 'scratchpad/optchat-bridge-smoke.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ isolation, modelRequests: contexts.length, compactionRequests, toolRoundTrips: 10, cleanup: true, existingContainersPreserved: existingContainers.length }, null, 2));
