#!/usr/bin/env node




import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { bashHint } from '../src/bash-hints.ts';
import { pipeStatusRefusal } from '../src/pipe-status-guard.ts';
import { winPathRefusal } from '../src/winpath-guard.ts';
import { branchEvidenceMessages, evidenceText, unbackedClaims } from '../src/claim-check.ts';

const path = process.argv[2];
if (!path) throw new Error('Pass a Pi session JSONL path');
const calls = new Map();
const samples = [];
const claimSamples = [];
const history = [];

for (const line of readFileSync(path, 'utf8').split('\n').slice(0, 8000)) {
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  const message = entry.message;
  if (message?.role === 'assistant' && message.stopReason === 'stop') {
    const reply = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (reply) claimSamples.push({ reply, history: history.slice(-400) });
  }
  if (entry.type === 'message' || entry.type === 'custom_message') history.push(entry);
  if (message?.role === 'assistant' && Array.isArray(message.content)) {
    for (const item of message.content) if (item.type === 'toolCall' && item.name === 'bash' && typeof item.arguments?.command === 'string') calls.set(item.id, item.arguments.command);
  } else if (message?.role === 'toolResult' && calls.has(message.toolCallId)) {
    const command = calls.get(message.toolCallId);
    calls.delete(message.toolCallId);
    const output = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    samples.push({ command, output });
  }
}
if (!samples.length) throw new Error('No completed bash calls found');
const measures = [
  ['pipe-status', ({ command }) => pipeStatusRefusal(command)],
  ['winpath (Linux)', ({ command }) => winPathRefusal(command, 'linux')],
  ['bash-hints', ({ command, output }) => bashHint(command, true, output)],
];
function report(name, times) {
  times.sort((a, b) => a - b);
  const [median, p95, max] = [times[Math.floor(times.length / 2)], times[Math.floor(times.length * .95)], times.at(-1)].map(n => n.toFixed(3));
  console.log(`${name}: total=${times.reduce((a, b) => a + b, 0).toFixed(3)} ms p50=${median} ms p95=${p95} ms max=${max} ms`);
}
console.log(`Completed bash calls: ${samples.length}`);
for (const [name, fn] of measures) {

  for (const sample of samples.slice(0, 100)) fn(sample);
  const times = samples.map(sample => { const start = performance.now(); fn(sample); return performance.now() - start; });
  report(name, times);
}
const claimTimes = claimSamples.map(({ reply, history }) => {
  const start = performance.now();
  unbackedClaims(reply, evidenceText(branchEvidenceMessages(history)));
  return performance.now() - start;
});
if (claimTimes.length) {
  report(`claim-check (${claimTimes.length} replies, preceding 400 entries)`, claimTimes);
  const evidence = evidenceText(branchEvidenceMessages(claimSamples.at(-1).history));
  const reply = Array.from({ length: 40 }, (_, i) => `Commit ${(0xa100000 + i).toString(16)}.`).join(' ');
  const start = performance.now();
  for (let i = 0; i < 30; i++) unbackedClaims(reply, evidence);
  console.log(`claim-check stress (40 hashes, last real evidence, 30 repeats): ${((performance.now() - start) / 30).toFixed(3)} ms/call`);
}
