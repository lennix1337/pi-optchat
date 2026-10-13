// Explicit opt-in real-provider benchmark. No production chat/profile or project files are used.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children, type AgentTiming } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';

const provider = process.env.BENCH_PROVIDER ?? 'openai-codex';
const model = process.env.BENCH_MODEL ?? 'gpt-6-luna';
const repeats = Number(process.env.BENCH_REPEATS ?? 2);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10, 'BENCH_REPEATS must be 1–10');
mkdirSync('scratchpad', { recursive: true });
const root = mkdtempSync(join('scratchpad', 'agent-benchmark-'));
const runtime = await ModelRuntime.create();
assert.ok(runtime.getModel(provider, model), `Model unavailable: ${provider}/${model}`);
const results: object[] = [];
try {
  for (let trial = 0; trial < repeats; trial++) {
    // Alternate order to reduce cache/order bias. Samples are not statistically conclusive.
    for (const thinking of (trial % 2 ? ['xhigh', 'medium'] : ['medium', 'xhigh']) as ('medium' | 'xhigh')[]) {
      const directory = join(process.cwd(), root, `${trial}-${thinking}`);
      mkdirSync(directory);
      const events: AgentTiming[] = [];
      let complete!: () => void;
      const delivered = new Promise<void>(resolve => { complete = resolve; });
      const memory = new Memory(directory, async input => input.source, () => {});
      const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider, model, thinking }),
        () => 'You are a benchmark subagent. Do not run memo, tools, delegate, or access files or networks. Follow the output contract exactly.',
        async () => {}, warning => console.error(warning), directory,
        { onTiming: event => { events.push(event); if (event.phase === 'delivered') complete(); },
          createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
      const began = performance.now();
      const timeout = setTimeout(() => { void children.close().finally(complete); }, 120_000);
      try {
        const [id] = await children.spawn([{ task: 'Sort these integers ascending and deduplicate them: 19, -3, 8, 19, 0, -3, 42, 8, 7. Return only the JSON array, without markdown.' }], directory);
        await delivered;
        const record = children.history.records.get(id)!;
        const event = (phase: AgentTiming['phase']) => events.find(e => e.runId === id && e.phase === phase);
        const prompt = event('prompt'), first = event('first_activity'), finished = event('finished');
        let valid = false;
        try { valid = record.state === 'completed' && JSON.stringify(JSON.parse(record.report ?? '')) === '[-3,0,7,8,19,42]'; } catch { /* Invalid output is a failed sample, not a discarded one. */ }
        const row = { trial, provider, model, requestedThinking: thinking, actualThinking: record.thinking, valid, state: record.state,
          totalMs: performance.now() - began, settleMs: events.find(e => e.phase === 'settle')?.durationMs,
          viewMs: events.find(e => e.phase === 'view')?.durationMs, openMs: event('open')?.durationMs,
          firstActivityMs: first && prompt ? first.atMs - prompt.atMs : null,
          executionMs: finished && prompt ? finished.atMs - prompt.atMs : null,
          deliveryMs: event('delivered') && finished ? event('delivered')!.atMs - finished.atMs : null,
          promptChars: prompt?.promptChars, events };
        results.push(row); console.log(JSON.stringify(row));
      } finally { clearTimeout(timeout); await children.close(); }
    }
  }
} finally {
  writeFileSync('scratchpad/agent-benchmark-results.json', JSON.stringify(results, null, 2) + '\n');
  rmSync(root, { recursive: true, force: true });
}
assert.ok(results.every(row => (row as { valid: boolean }).valid), 'One or more tasks failed quality/state validation');
