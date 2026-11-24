import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SessionManager } from '@earendil-works/pi-coding-agent';

test('offline heap attribution reports separate session, memory and render phases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heap-owners-test-'));
  try {
    const profile = join(dir, 'profile'); mkdirSync(profile);
    const sessions = join(dir, 'sessions'); mkdirSync(sessions);
    const session = SessionManager.create(dir, sessions);
    session.appendMessage({ role: 'user', content: 'fixture', timestamp: 1 });
    const run = spawnSync(process.execPath, ['--expose-gc', '--experimental-transform-types', '--no-warnings', 'scripts/heap-owners.ts', '--source', profile, '--session', session.getSessionFile()!], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.phases.map((p: { phase: string }) => p.phase), ['baseline', 'session', 'memory', 'render']);
    assert.equal(result.sessionEntries, 1);
    assert.ok(result.phases.every((p: { heapBytes: number; deltaBytes: number }) => Number.isFinite(p.heapBytes) && Number.isFinite(p.deltaBytes)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
