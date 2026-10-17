import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { OutputContext } from '../src/output-context.ts';
import { OutputStore } from '../src/output-store.ts';

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const root = resolve(import.meta.dirname, '..');
const baselineRoot = process.argv[2] ? resolve(process.argv[2]) : root;
const baseline = await import(pathToFileURL(join(baselineRoot, 'src/output-context.ts')).href);
const directory = mkdtempSync(join(tmpdir(), 'optchat-benchmark-'));
try {
  const message = { role: 'toolResult', toolName: 'bash', toolCallId: 'x', content: [{ type: 'text', text: 'x'.repeat(250_000) }],
    isError: false, timestamp: 1 } as AgentMessage;
  const contexts = [new baseline.OutputContext(new OutputStore(directory, 'before')), new OutputContext(new OutputStore(directory, 'after'))];
  const projection: number[][] = [[], []], startup: number[][] = [[], []];
  for (const context of contexts) assert.equal(context.project([message])[0], message);
  for (let sample = 0; sample < 9; sample++) {
    for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      for (let i = 0; i < 100; i++) assert.equal(contexts[index].project([message])[0], message);
      projection[index].push((performance.now() - start) / 100);
    }
  }
  for (let sample = 0; sample < 7; sample++) {
    for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const entry = pathToFileURL(join(index ? root : baselineRoot, 'src/index.ts')).href;
      const script = `const start=performance.now();await import(${JSON.stringify(entry)});console.log(JSON.stringify({ms:performance.now()-start}));`;
      const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
        { cwd: root, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
      startup[index].push(JSON.parse(result.trim()).ms);
    }
  }
  console.log(JSON.stringify({ protocol: 'offline alternating order; same Node/toolchain; fresh process import, no session/provider/auth access',
    node: process.version, projection: { iterationsPerSample: 100, samples: projection, medianMs: projection.map(median),
      inputBytes: 250_000, unchangedOutput: true }, startup: { samples: startup, medianMs: startup.map(median) },
    limits: 'Repeated immutable-message CPU and extension module import only; not model latency, billing, full startup UI, or task success.' }, null, 2));
} finally { rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); }
