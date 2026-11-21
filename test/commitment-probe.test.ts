import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCommitment, readCommitments, updateCommitment } from '../src/commitments.ts';
import { executeProbe, runProbes } from '../src/commitment-probe.ts';
import { dueFindings } from '../src/commitment-due.ts';

const now = Date.parse('2026-01-01T00:00:00Z');
async function fixture(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const probe = { argv: ['git', 'status', '--short'], expect: 'clean' };
test('pass closes with argv, output and time evidence', () => fixture(async dir => {
  const c = addCommitment(dir, { text: 'verify', source: 'test', probe }, now);
  const findings = await runProbes(dir, now, async () => ({ output: 'CLEAN', ok: true }));
  const item = readCommitments(dir).find(item => item.id === c.id)!;
  assert.equal(item.status, 'done'); assert.match(item.evidence!, /git/); assert.match(item.evidence!, /CLEAN/); assert.match(item.evidence!, /2026-01-01/); assert.equal(findings.length, 0);
}));
test('fail and mismatch record progress and signal once per day for same output', () => fixture(async dir => {
  const c = addCommitment(dir, { text: 'verify', source: 'test', probe: { ...probe, every: 1 } }, now);
  const run = async () => ({ output: 'broken', ok: true });
  assert.equal((await runProbes(dir, now, run)).length, 1);
  assert.match(readCommitments(dir).find(item => item.id === c.id)!.notes.at(-1)!.text, /broken/);
  assert.equal((await runProbes(dir, now + 60_000, run)).length, 0);
  assert.equal((await runProbes(dir, now + 86_400_000, run)).length, 1);
}));
test('returning to the same failure within a day does not wake twice', () => {
  const item = { id: 'c_1', text: 'verify', owner: 'optchat', status: 'open' };
  const first = dueFindings([{ ...item, probeState: { at: now, failure: 'a' } }], { dueSeen: [], escalated: {} }, now);
  const second = dueFindings([{ ...item, probeState: { at: now + 1, failure: 'b' } }], first.state, now + 1);
  const third = dueFindings([{ ...item, probeState: { at: now + 2, failure: 'a' } }], second.state, now + 2);
  assert.equal(first.findings.length, 1); assert.equal(second.findings.length, 1); assert.equal(third.findings.length, 0);
});
test('timeout fails and literal argv reaches executor', () => fixture(async dir => {
  const argv = ['git', 'log', '--', ';', '&&'];
  addCommitment(dir, { text: 'verify', source: 'test', probe: { argv, expect: 'ok' } }, now);
  const findings = await runProbes(dir, now, async p => { assert.deepEqual(p.argv, argv); return { output: 'timeout', ok: false }; });
  assert.equal(findings.length, 1); assert.match(findings[0].line, /timeout/);
}));
test('a real timed-out process is recorded as failure', () => fixture(async dir => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    addCommitment(dir, { text: 'verify', source: 'test', probe: { argv: ['curl', `http://127.0.0.1:${address.port}`], expect: 'ok' } }, now);
    const findings = await runProbes(dir, now, p => executeProbe(p, 150));
    assert.equal(findings.length, 1);
    assert.equal(readCommitments(dir)[0].status, 'open');
    assert.match(readCommitments(dir)[0].notes.at(-1)!.text, /failed/i);
  } finally { server.closeAllConnections(); server.close(); }
}));
test('real process treats shell operators as literal path arguments', () => fixture(async dir => {
  execFileSync('git', ['init', '-q', dir]);
  const marker = join(dir, 'shell-ran');
  const argv = ['git', 'status', '--short', '--', ';', '&&', 'git', 'init', marker];
  addCommitment(dir, { text: 'verify', source: 'test', probe: { argv, cwd: dir, expect: '^$' } }, now);
  await runProbes(dir, now);
  assert.equal(existsSync(marker), false);
  assert.equal(readCommitments(dir)[0].status, 'done');
}));
test('update validates, and a modified stored probe is refused again before execution', () => fixture(async dir => {
  const c = addCommitment(dir, { text: 'verify', source: 'test' }, now);
  assert.throws(() => updateCommitment(dir, { id: c.id, probe: { argv: ['git', 'push'], expect: 'ok' } }, now), /probe/i);
  updateCommitment(dir, { id: c.id, probe }, now);
  const file = join(dir, 'commitments.json');
  const document = JSON.parse(readFileSync(file, 'utf8'));
  document.items[0].probe.argv = ['git', 'push'];
  writeFileSync(file, JSON.stringify(document));
  let executed = false;
  const findings = await runProbes(dir, now, async () => { executed = true; return { ok: true, output: 'ok' }; });
  assert.equal(executed, false); assert.equal(findings.length, 1); assert.match(findings[0].line, /allowlist/);
}));
test('read-only forms are accepted; writes and script executables are rejected', () => fixture(async dir => {
  for (const argv of [['git', 'status'], ['gh', 'pr', 'view', '12'], ['curl', 'https://example.com']]) {
    assert.doesNotThrow(() => addCommitment(dir, { text: 'verify', source: 'test', probe: { argv, expect: 'ok' } }, now));
  }
  for (const argv of [['gh', 'pr', 'merge', '12'], ['gh', 'api', 'repos/x/y', '-X', 'DELETE'], ['curl', '-d', 'x', 'https://example.com'], ['git', 'push'], ['node', 'script.js'], ['pwsh', 'deploy-web.ps1']]) {
    assert.throws(() => addCommitment(dir, { text: 'verify', source: 'test', probe: { argv, expect: 'ok' } }, now), /probe/i, argv.join(' '));
  }
}));
test('git log accepts a commit count, and a refusal names what is accepted', () => fixture(async dir => {
  for (const argv of [['git', 'log', '--oneline', '-30', 'origin/main'], ['git', '-C', dir, 'log', '--max-count=5']]) {
    assert.doesNotThrow(() => addCommitment(dir, { text: 'verify', source: 'test', probe: { argv, expect: 'ok' } }, now), argv.join(' '));
  }
  assert.throws(() => addCommitment(dir, { text: 'verify', source: 'test', probe: { argv: ['git', 'log', '--format=%H'], expect: 'ok' } }, now), /accepted:.*--oneline.*--format=%H. is not in the read-only allowlist$/);
  assert.throws(() => addCommitment(dir, { text: 'verify', source: 'test', probe: { argv: ['node', 'x.js'], expect: 'ok' } }, now), /accepted:.*git.*gh.*curl/);
}));

test('ps accepts a process measurement by pid or name and nothing else', () => fixture(async dir => {
  for (const argv of [['ps', '-o', 'rss=', '-p', '540353'], ['ps', '-o', 'pid,rss,etime', '-p', '1,2'], ['ps', '-o', 'rss', '-C', 'node']]) {
    assert.doesNotThrow(() => addCommitment(dir, { text: 'verify', source: 'test', probe: { argv, expect: '\\d' } }, now), argv.join(' '));
  }
  for (const argv of [['ps', 'aux'], ['ps', '-o', 'args', '-p', '1'], ['ps', '-o', 'rss', '-p', '1;id'], ['ps', '-o', 'rss'], ['ps', '-eo', 'rss']]) {
    assert.throws(() => addCommitment(dir, { text: 'verify', source: 'test', probe: { argv, expect: 'ok' } }, now), /probe/i, argv.join(' '));
  }
}));
