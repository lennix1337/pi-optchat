import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { formatSummaryReport, startCaptureProxy } from '../debug-capture.mjs';

const ITERATIONS = 10;
const detail = process.argv.includes('--detail');

async function runTwoTurnScenario() {
  let turn = 0;
  const fake = http.createServer((req, res) => {
    turn++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `msg_${turn}`,
        usage: turn === 1
          ? { input_tokens: 100, cache_creation_input_tokens: 1100, cache_read_input_tokens: 0, output_tokens: 45 }
          : { input_tokens: 140, cache_creation_input_tokens: 1200, cache_read_input_tokens: 0, output_tokens: 38 },
      }));
    });
  });

  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const fakePort = fake.address().port;
  const outDir = mkdtempSync(join(tmpdir(), 'bench-debug-capture-'));
  const proxy = await startCaptureProxy({ target: `http://127.0.0.1:${fakePort}`, outDir });

  const turn1 = {
    model: 'claude-sonnet-4-5',
    tools: [
      { name: 'read_file', description: 'Read file contents', input_schema: { type: 'object' } },
      { name: 'bash', description: 'Execute shell command', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
      { name: 'grep', description: 'Search files', input_schema: { type: 'object' } },
    ],
    system: [
      { type: 'text', text: 'System instructions', cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Check repo status', cache_control: { type: 'ephemeral' } }] },
    ],
  };

  // Synthetic Turn 2: mutates tool `bash` in tools[1], breaking the KV-cache prefix.
  const turn2 = {
    model: 'claude-sonnet-4-5',
    tools: [
      turn1.tools[0],
      { name: 'bash', description: 'Execute shell command with timeout', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
      turn1.tools[2],
    ],
    system: turn1.system,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Check repo status' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Clean working tree.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Run tests', cache_control: { type: 'ephemeral' } }] },
    ],
  };

  const t0 = performance.now();
  try {
    for (const payload of [turn1, turn2]) {
      const res = await fetch(`${proxy.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer bench-dummy-token' },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 200);
      await res.json();
    }
    const summary = await proxy.close();
    const elapsedMs = performance.now() - t0;

    assert.equal(summary.turnCount, 2);
    assert.equal(summary.cacheBreaks, 1);
    const tr = summary.transitions[0];
    assert.equal(tr.cacheBroken, true);
    assert.equal(tr.cause?.section, 'tools');
    assert.equal(tr.cause?.index, 1);
    assert.equal(tr.cause?.toolName, 'bash');
    assert.ok(typeof tr.firstDiffByte === 'number' && tr.firstDiffByte > 0);

    return { elapsedMs, summary };
  } finally {
    await new Promise((resolve) => fake.close(resolve));
    rmSync(outDir, { recursive: true, force: true });
  }
}

const samples = [];
let lastSummary = null;
for (let i = 0; i < ITERATIONS; i++) {
  const { elapsedMs, summary } = await runTwoTurnScenario();
  samples.push(elapsedMs);
  lastSummary = summary;
}

samples.sort((a, b) => a - b);
const medianMs = +samples[Math.floor(samples.length / 2)].toFixed(2);

if (detail && lastSummary) {
  console.log(formatSummaryReport(lastSummary));
  console.log('');
}

console.log(JSON.stringify({
  metric: 'debug_capture_2turn_diff_ms',
  value: medianMs,
  unit: 'ms',
  lowerIsBetter: true,
}));
