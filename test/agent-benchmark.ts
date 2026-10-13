// Explicit opt-in real-provider benchmark. No production chat/profile or project files are used.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children, type AgentTiming } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';

const provider = process.env.BENCH_PROVIDER ?? 'openai-codex';
const model = process.env.BENCH_MODEL ?? 'gpt-6-luna';
const workload = process.env.BENCH_TASK ?? 'reasoning';
assert.ok(['reasoning', 'coding'].includes(workload), 'BENCH_TASK must be reasoning or coding');
const repeats = Number(process.env.BENCH_REPEATS ?? 2);
const codingTests = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeInvoices } from './invoices.mjs';
test('aggregates paid invoices in integer cents, grouped by currency', () => {
  assert.deepEqual(summarizeInvoices([
    { status: 'paid', currency: 'USD', cents: 101 },
    { status: 'pending', currency: 'USD', cents: 999 },
    { status: 'paid', currency: 'USD', cents: 202 },
    { status: 'paid', currency: 'BRL', cents: 50 },
    { status: 'paid', currency: 'USD', cents: -1 },
  ]), { USD: 302, BRL: 50 });
});
test('empty and unpaid inputs', () => {
  assert.deepEqual(summarizeInvoices([]), {});
  assert.deepEqual(summarizeInvoices([{ status: 'pending', currency: 'USD', cents: 1 }]), {});
});
test('rejects noninteger paid amounts and safely handles arbitrary currency keys', () => {
  assert.throws(() => summarizeInvoices([{ status: 'paid', currency: 'USD', cents: 0.1 }]), TypeError);
  assert.throws(() => summarizeInvoices([{ status: 'paid', currency: 'USD', cents: NaN }]), TypeError);
  assert.equal(Object.hasOwn(summarizeInvoices([{ status: 'paid', currency: '__proto__', cents: 1 }]), '__proto__'), true);
});
`;
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
      if (workload === 'coding') {
        writeFileSync(join(directory, 'invoices.mjs'), 'export function summarizeInvoices(invoices) { return {}; }\n');
        writeFileSync(join(directory, 'invoices.test.mjs'), codingTests);
      }
      const events: AgentTiming[] = [];
      let complete!: () => void;
      const delivered = new Promise<void>(resolve => { complete = resolve; });
      const memory = new Memory(directory, async input => input.source, () => {});
      const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider, model, thinking }),
        () => workload === 'coding'
          ? 'You are a subagent. Do not run memo or delegate. Work only inside your task cwd. No network, dependency installs or Git operations. Implement the task using the installed file/shell tools; do not alter the supplied tests.'
          : 'You are a benchmark subagent. Do not run memo, tools, delegate, or access files or networks. Follow the output contract exactly.',
        async () => {}, warning => console.error(warning), directory,
        { onTiming: event => { events.push(event); if (event.phase === 'delivered') complete(); },
          createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
      const began = performance.now();
      const timeout = setTimeout(() => { void children.close().finally(complete); }, workload === 'coding' ? 240_000 : 120_000);
      try {
        const task = workload === 'coding'
          ? 'Implement summarizeInvoices in invoices.mjs: aggregate only paid invoices by currency in integer cents, support negative refunds, return an ordinary object with safe own keys, and throw TypeError for non-safe-integer paid cents. Read the supplied invoices.test.mjs, add separate regression tests for any missing edges, and run node --test. Do not modify invoices.test.mjs. Finish with a brief report.'
          : 'Sort these integers ascending and deduplicate them: 19, -3, 8, 19, 0, -3, 42, 8, 7. Return only the JSON array, without markdown.';
        const [id] = await children.spawn([{ task }], directory);
        await delivered;
        const totalMs = performance.now() - began;
        const record = children.history.records.get(id)!;
        const event = (phase: AgentTiming['phase']) => events.find(e => e.runId === id && e.phase === phase);
        const prompt = event('prompt'), first = event('first_activity'), finished = event('finished');
        let valid = false;
        try {
          if (workload === 'coding') {
            assert.equal(readFileSync(join(directory, 'invoices.test.mjs'), 'utf8'), codingTests);
            execFileSync(process.execPath, ['--test'], { cwd: directory, timeout: 10_000, stdio: 'pipe' });
            valid = record.state === 'completed';
          } else valid = record.state === 'completed' && JSON.stringify(JSON.parse(record.report ?? '')) === '[-3,0,7,8,19,42]';
        } catch { /* Invalid output is a failed sample, not a discarded one. */ }
        const row = { workload, trial, provider, model, requestedThinking: thinking, actualThinking: record.thinking, valid, state: record.state,
          totalMs, settleMs: events.find(e => e.phase === 'settle')?.durationMs,
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
  writeFileSync(`scratchpad/agent-benchmark-${workload}-results.json`, JSON.stringify(results, null, 2) + '\n');
  rmSync(root, { recursive: true, force: true });
}
assert.ok(results.every(row => (row as { valid: boolean }).valid), 'One or more tasks failed quality/state validation');
