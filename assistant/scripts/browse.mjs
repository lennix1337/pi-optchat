#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createComputers } from '../src/computer/manager.ts';
import { createGateway } from '../src/policy/gateway.ts';
import { browserReadRequest, openBrowserRead } from '../src/computer/browser-egress.ts';

const usage = 'Usage: node assistant/scripts/browse.mjs --url HTTPS_URL --origin HTTPS_ORIGIN [--origin HTTPS_ORIGIN ...] [--image IMAGE]';
async function main() {
  const { values, positionals } = parseArgs({ options: { url: { type: 'string' }, origin: { type: 'string', multiple: true }, image: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true });
  if (values.help) { console.log(usage); return; }
  if (positionals.length || !values.url || !values.origin?.length) throw new Error(usage);
  const dir = mkdtempSync(join(tmpdir(), 'optchat-public-browser-'));
  const owner = `public-${randomUUID()}`;
  const authority = {};
  const databasePath = join(dir, 'browser.db');
  const computers = createComputers({ databasePath, owner, operatorAuthority: authority, image: values.image ?? 'optchat-computer-browser-egress:1' });
  const gateway = createGateway({ databasePath, profileId: 'public', operatorAuthority: authority, policy: () => 'allow', inspect: () => ({ decision: 'allow', reasons: [] }) });
  let result, failure, cleanup;
  try {
    const computer = await computers.create('public', 'operator');
    const base = { version: 1, operationId: randomUUID(), profileId: 'public', sessionId: 'operator', taskId: 'public-read', runId: randomUUID(), policyVersion: 'operator-public-read', expiresAt: Date.now() + 120_000 };
    result = await openBrowserRead(gateway, computers, browserReadRequest(base, computer, { url: values.url, origins: values.origin }));
  } catch (error) { failure = error; }
  try { await computers.cleanup(); } catch (error) { cleanup = error; }
  gateway.close(); computers.close();
  if (!cleanup) rmSync(dir, { recursive: true, force: true });
  if (failure || cleanup) {
    console.log(JSON.stringify({ result: 'error', code: cleanup ? 'computer_cleanup_failed' : failure.message, browserReason: failure?.browserReason, owner, containerCleanup: cleanup ? 'uncertain' : 'complete', ...(cleanup ? { databaseDirectory: dir } : {}) }));
    process.exitCode = 1;
  } else console.log(JSON.stringify({ result: 'ok', mode: 'public_https_read', ...result, owner, containerCleanup: 'complete' }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
