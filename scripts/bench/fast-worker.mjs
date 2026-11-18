#!/usr/bin/env node
// Offline benchmark for fast-path plan/mechanical workers (no external MCP servers vs opt-out mcp: true).
// Prints JSON { metric, value, unit, lowerIsBetter, ... } to stdout.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FAKE_MCP = resolve(ROOT, 'test/fixtures/fake-mcp.mjs');
const ROUNDS = 3;

function pidsFromLog(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    .filter(line => line.startsWith('start '))
    .map(line => Number(line.split(' ')[1]))
    .filter(Number.isFinite);
}

function sumProcessRssBytes(pids) {
  if (!pids.length) return 0;
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `@(${pids.join(',')}) | ForEach-Object { try { (Get-Process -Id $_ -ErrorAction Stop).WorkingSet64 } catch { 0 } } | Measure-Object -Sum | Select-Object -ExpandProperty Sum`],
      { encoding: 'utf8' });
    return Number(r.stdout?.trim()) || 0;
  }
  const r = spawnSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
  return (r.stdout ?? '').trim().split(/\s+/).reduce((sum, kb) => sum + (Number(kb) || 0) * 1024, 0);
}

async function runCase({ kind, mcp }) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-fast-worker-bench-'));
  const agentDir = join(dir, 'agent');
  const log = join(dir, 'servers.log');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      mcp1: { command: process.execPath, args: [FAKE_MCP, log], exposure: 'codemode' },
      mcp2: { command: process.execPath, args: [FAKE_MCP, log], exposure: 'codemode' },
      mcp3: { command: process.execPath, args: [FAKE_MCP, log], exposure: 'direct' },
    },
  }));

  const childScript = `
    import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
    import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
    import { Children } from '${pathToFileURL(resolve(ROOT, 'src/agents.ts')).href}';
    import { Memory } from '${pathToFileURL(resolve(ROOT, 'src/memory.ts')).href}';
    import { emptyUsage } from '${pathToFileURL(resolve(ROOT, 'src/usage.ts')).href}';

    globalThis.fetch = () => Promise.reject(new Error('offline bench: network blocked'));
    const dir = ${JSON.stringify(dir)};
    const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
    const runtime = await ModelRuntime.create({ authPath: dir + '/auth.json', modelsPath: null, modelsStorePath: dir + '/models-cache.json', refreshOnCreate: false });
    runtime.registerProvider('optchat-bench', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'local-fake', name: 'Local Fake', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model) {
        const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
        return stream;
      },
    });
    let firstActivityAt;
    const children = new Children(memory, new ModelRegistry(runtime),
      () => ({ provider: 'optchat-bench', model: 'local-fake', thinking: 'minimal' }), () => '',
      async () => {}, () => {}, dir,
      {
        settings: () => ({ subagentLevels: 1, maxAgents: 8 }),
        builtins: () => ['mcp', 'codemode', 'tool-search'],
        onTiming: ev => { if (ev.phase === 'first_activity' && firstActivityAt === undefined) firstActivityAt = ev.atMs; },
        createSession: options => createAgentSession({ ...options, modelRuntime: runtime }),
      });
    const t0 = performance.now();
    await children.spawn([{
      task: 'Goal: inspect\\nAcceptance: ok\\nEvidence: ok\\nAuthority: read-only',
      kind: ${JSON.stringify(kind)},
      ${mcp === undefined ? '' : `mcp: ${JSON.stringify(mcp)},`}
    }], dir);
    while (children.active) await new Promise(r => setTimeout(r, 10));
    const firstResponseMs = (firstActivityAt ?? performance.now()) - t0;
    const workerRssBytes = process.memoryUsage().rss;
    console.log(JSON.stringify({ firstResponseMs, workerRssBytes }));
    await children.close();
    await memory.close();
  `;

  try {
    const r = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--input-type=module', '-e', childScript], {
      cwd: ROOT,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`Bench child failed (${r.status}): ${r.stderr}\n${r.stdout}`);
    const lastLine = r.stdout.trim().split('\n').filter(Boolean).at(-1);
    const parsed = JSON.parse(lastLine);
    const pids = pidsFromLog(log);
    // Re-measure or note: servers may have already exited at close(), so spawn count is exact and workerRssBytes is measured live.
    return {
      firstResponseMs: Number(parsed.firstResponseMs.toFixed(2)),
      workerRssMb: Number((parsed.workerRssBytes / (1024 * 1024)).toFixed(2)),
      mcpServers: pids.length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function bench(spec) {
  const runs = [];
  for (let i = 0; i < ROUNDS; i++) runs.push(await runCase(spec));
  return {
    firstResponseMs: median(runs.map(r => r.firstResponseMs)),
    workerRssMb: median(runs.map(r => r.workerRssMb)),
    mcpServers: runs[0].mcpServers,
  };
}

const before = await bench({ kind: 'plan', mcp: true });
const afterPlan = await bench({ kind: 'plan' });
const afterMechanical = await bench({ kind: 'mechanical' });

// Also measure RSS of 3 live fake-mcp processes directly so we report real OS WorkingSet64 saved.
async function measureMcpRssMb(count) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-mcp-rss-'));
  const log = join(dir, 'servers.log');
  const children = Array.from({ length: count }, () => spawn(process.execPath, [FAKE_MCP, log], { stdio: ['pipe', 'pipe', 'ignore'] }));
  try {
    const deadline = Date.now() + 5000;
    while (pidsFromLog(log).length < count && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 100));
    return Number((sumProcessRssBytes(children.map(c => c.pid).filter(Boolean)) / (1024 * 1024)).toFixed(2));
  } finally {
    for (const c of children) c.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const mcp3RssMb = await measureMcpRssMb(3);
const beforeTotalRssMb = Number((before.workerRssMb + mcp3RssMb).toFixed(2));
const rssSavedMb = Number((beforeTotalRssMb - afterPlan.workerRssMb).toFixed(2));

console.log(JSON.stringify({
  metric: 'fast_worker_first_response_ms',
  value: afterPlan.firstResponseMs,
  unit: 'ms',
  lowerIsBetter: true,
  before: { ...before, mcpRssMb: mcp3RssMb, totalRssMb: beforeTotalRssMb },
  after: {
    plan: { ...afterPlan, mcpRssMb: 0, totalRssMb: afterPlan.workerRssMb },
    mechanical: { ...afterMechanical, mcpRssMb: 0, totalRssMb: afterMechanical.workerRssMb },
  },
  rssSavedMb,
}, null, 2));
