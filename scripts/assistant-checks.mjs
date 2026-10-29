#!/usr/bin/env node
// Runs the assistant's hermetic checks from .pi/checks.json in sequence, so CI covers the assistant
// (its own Node 24 boundary, tests and typecheck) with the exact commands used locally.
// Usage: node scripts/assistant-checks.mjs [--mutations]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Checks CI cannot run, with the reason; everything else named assistant-* runs. */
const NEEDS_MACHINE = {
  'assistant-computer': 'Docker engine and a prebuilt node image',
  'assistant-browser-egress-docker': 'Docker engine and the prebuilt egress image',
  'assistant-browser-egress-live': 'Docker and public network reads',
  'assistant-installed': 'an installed Pi SDK',
  'assistant-executor-tools-journey': 'Docker engine and the prebuilt browser image',
};
const withMutations = process.argv.includes('--mutations');
const { checks } = JSON.parse(readFileSync(new URL('../.pi/checks.json', import.meta.url), 'utf8'));
const selected = Object.entries(checks).filter(([name]) => name.startsWith('assistant-') && !NEEDS_MACHINE[name] &&
  (withMutations || !name.endsWith('-mutations')));

const failed = [];
for (const [name, check] of selected) {
  const started = Date.now();
  console.log(`\n=== ${name}`);
  const [command, ...args] = check.argv;
  const result = spawnSync(command === 'node' ? process.execPath : command, args, { stdio: 'inherit', timeout: check.timeoutMs ?? 120_000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const outcome = result.error ? `error ${result.error.code ?? result.error.message}` : result.status === 0 ? 'passed' : `exit ${result.status ?? result.signal}`;
  console.log(`=== ${name}: ${outcome} in ${seconds}s`);
  if (outcome !== 'passed') failed.push(`${name} (${outcome})`);
}
for (const [name, reason] of Object.entries(NEEDS_MACHINE)) console.log(`skipped ${name}: needs ${reason}`);
if (!withMutations) console.log('skipped *-mutations: run with --mutations');
console.log(failed.length ? `\nFAILED ${failed.length}/${selected.length}: ${failed.join(', ')}` : `\nall ${selected.length} assistant checks passed`);
process.exitCode = failed.length ? 1 : 0;
