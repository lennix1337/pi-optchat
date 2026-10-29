#!/usr/bin/env node
// Operator-only disposable offline text preview; this is not a network browser.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { dockerCli, probeDocker } from '../src/computer/docker.ts';
import { createComputers } from '../src/computer/manager.ts';
import { browserTextRequest, openBrowserText } from '../src/computer/effects.ts';
import { createGateway } from '../src/policy/gateway.ts';

const usage = 'Usage: node assistant/scripts/computer.mjs status [--image IMAGE] | preview --text TEXT [--image IMAGE]';
async function main() {
  const { values, positionals } = parseArgs({ options: { image: { type: 'string' }, text: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true, strict: true });
  if (values.help) { console.log(usage); return; }
  const image = values.image ?? 'optchat-computer-browser:1';
  if (positionals.length !== 1 || !image || !['status', 'preview'].includes(positionals[0]) || (positionals[0] === 'status' && values.text !== undefined) || (positionals[0] === 'preview' && values.text === undefined)) throw new Error('usage');
  if (positionals[0] === 'status') { console.log(JSON.stringify({ result: 'status', mode: 'offline_text_only', probe: await probeDocker(image) })); return; }
  const owner = `preview-${randomUUID()}`;
  const dir = mkdtempSync(join(tmpdir(), 'optchat-computer-preview-'));
  const databasePath = join(dir, 'preview.db');
  const authority = {};
  let computers, gateway, result, failure, cleanupFailure;
  try {
    computers = createComputers({ databasePath, owner, operatorAuthority: authority, image });
    gateway = createGateway({ databasePath, profileId: 'preview', operatorAuthority: authority, policy: () => 'allow', inspect: () => ({ decision: 'allow', reasons: [] }) });
    const computer = await computers.create('preview', 'operator');
    const base = { version: 1, operationId: randomUUID(), profileId: 'preview', sessionId: 'operator', taskId: 'preview', runId: randomUUID(), policyVersion: 'operator-offline', expiresAt: Date.now() + 300_000 };
    const snapshot = await openBrowserText(gateway, computers, browserTextRequest(base, computer, values.text));
    result = { result: 'ok', mode: 'offline_text_only', snapshot };
  } catch (error) { failure = error; }
  try {
    if (computers) await computers.cleanup();
    const remaining = await dockerCli(['ps', '--all', '--filter', `label=optchat.computer.owner=${owner}`, '--format', '{{.Names}}']);
    if (remaining.code !== 0 || remaining.stdout.trim()) throw new Error('computer_cleanup_failed');
  } catch (error) { cleanupFailure = error; }
  try { gateway?.close(); computers?.close(); } catch (error) { cleanupFailure ??= error; }
  if (!cleanupFailure) rmSync(dir, { recursive: true, force: true });
  if (cleanupFailure) {
    console.log(JSON.stringify({ result: 'error', code: 'computer_cleanup_failed', owner, databaseDirectory: dir, originalCode: failure?.message }));
    process.exitCode = 1;
  } else if (failure) {
    console.log(JSON.stringify({ result: 'error', code: failure.message, sessionId: failure.sessionId, container: failure.container, cleanupReason: failure.cleanupReason, containerCleanup: 'complete' }));
    process.exitCode = 1;
  } else console.log(JSON.stringify({ ...result, owner, containerCleanup: 'complete' }));
}
main().catch(error => { console.error(error.message === 'usage' ? usage : error.message); process.exitCode = 1; });
