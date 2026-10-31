import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOutcomeInput, parseSignal } from '../assistant/src/contracts/signals.ts';
import {
  MAX_SPOOL_BYTES, appendOutcome, appendSignal, appendSignals, recordShellOutcome, recordSubagentSignal,
} from '../src/journal-spool.ts';

function profile(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'journal-spool-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const AT = Date.parse('2026-10-30T12:00:00.000Z');

test('a Pi producer appends one valid signal to the profile spool, clippable and without the service', () => {
  profile(dir => {
    assert.equal(appendSignal(dir, {
      source: 'health', kind: 'health.down', subject: 'API\nDentAI', summary: 'x'.repeat(600),
      dedupeKey: 'health:API:down:1', severity: 'critical', attention: 'notify', evidence: 'health:prod',
      correlationId: 'run-1', observedAt: AT,
    }), true);
    const file = join(dir, 'signals', 'inbox.jsonl');
    const [line] = lines(file);
    const signal = parseSignal(JSON.parse(line));
    assert.equal(signal.profileId, dir.split(/[\\/]/).pop());
    assert.equal(signal.observedAt, new Date(AT).toISOString());
    assert.equal(signal.subject, 'API DentAI');
    assert.equal(signal.summary.length, 500);
    assert.equal(signal.severity, 'critical');
    assert.deepEqual(signal.evidence, { kind: 'observed', reference: 'health:prod' });
    assert.equal(signal.kind, 'health.down');
  });
});

test('outcomes use their own spool and keep the work expectation, verification and cost', () => {
  profile(dir => {
    assert.equal(appendOutcome(dir, {
      outcomeId: 'shell:session:job', capability: 'shell', expectation: 'exit 0', result: 'completed',
      verification: 'verified', evidence: 'log:C:/tmp/x.log', latencyMs: 1234.4, modelCalls: 0,
      costUsd: 0.12345678, observedAt: AT,
    }), true);
    const [line] = lines(join(dir, 'signals', 'outcomes.jsonl'));
    const outcome = parseOutcomeInput(JSON.parse(line));
    assert.equal(outcome.outcomeId, 'shell:session:job');
    assert.equal(outcome.latencyMs, 1234);
    assert.equal(outcome.costUsd, 0.123457);
    assert.equal(outcome.verification, 'verified');
    assert.equal(outcome.observedAt, new Date(AT).toISOString());
  });
});

test('invalid observations are refused instead of written, and a producer never throws', () => {
  profile(dir => {
    assert.equal(appendSignal(dir, { source: 'browser' as never, kind: 'health.down', subject: 'x', summary: 'y', dedupeKey: 'z' }), false);
    assert.equal(appendSignal(dir, { source: 'health', kind: 'health.down', subject: ' ', summary: 'y', dedupeKey: 'z' }), false);
    assert.equal(appendOutcome(dir, { outcomeId: 'o', capability: 'Deploy', expectation: 'e', result: 'r', verification: 'verified', evidence: 'x' }), false);
    assert.equal(appendSignals(dir, [{ source: 'health', kind: 'health.down', subject: 'x', summary: 'y', dedupeKey: 'z' }]), 1);
    assert.equal(lines(join(dir, 'signals', 'inbox.jsonl')).length, 1);
    assert.equal(existsSync(join(dir, 'signals', 'outcomes.jsonl')), false);
  });
});

test('the spool is bounded: past the limit a writer drops the line instead of growing without end', () => {
  profile(dir => {
    const signals = join(dir, 'signals');
    mkdirSync(signals, { recursive: true });
    writeFileSync(join(signals, 'inbox.jsonl'), Buffer.alloc(MAX_SPOOL_BYTES + 1));
    assert.equal(appendSignal(dir, { source: 'health', kind: 'health.down', subject: 'x', summary: 'y', dedupeKey: 'z' }), false);
    assert.equal(readFileSync(join(signals, 'inbox.jsonl')).length, MAX_SPOOL_BYTES + 1);
  });
});

test('a background shell becomes a verified outcome only when it exited zero', () => {
  profile(dir => {
    const base = { id: 'job-1', command: 'pnpm build', started: AT - 5000 };
    assert.equal(recordShellOutcome(dir, 'session-1', { ...base, state: 'completed', ended: AT, exitCode: 0 }), true);
    recordShellOutcome(dir, 'session-1', { ...base, id: 'job-2', state: 'failed', ended: AT, exitCode: 2 });
    recordShellOutcome(dir, 'session-1', { ...base, id: 'job-3', state: 'stopped', ended: AT });
    const outcomes = lines(join(dir, 'signals', 'outcomes.jsonl')).map(line => parseOutcomeInput(JSON.parse(line)));
    assert.deepEqual(outcomes.map(o => [o.outcomeId, o.verification, o.latencyMs, o.modelCalls, o.costUsd]), [
      ['shell:session-1:job-1', 'verified', 5000, 0, 0],
      ['shell:session-1:job-2', 'not_verified', 5000, 0, 0],
      ['shell:session-1:job-3', 'not_verified', 5000, 0, 0],
    ]);
    assert.match(outcomes[0].result, /completed \(exit 0\)/);
    assert.match(outcomes[1].result, /failed \(exit 2\)/);
    assert.match(outcomes[0].expectation, /pnpm build/);
  });
});

test('a top-level subagent end is recorded, while a stop in progress is not', () => {
  profile(dir => {
    const base = { id: 'run-1', task: 'Review the pull request', started: AT - 10_000, ended: AT };
    assert.equal(recordSubagentSignal(dir, { ...base, state: 'completed' }), true);
    assert.equal(recordSubagentSignal(dir, { ...base, id: 'run-2', state: 'failed' }), true);
    assert.equal(recordSubagentSignal(dir, { ...base, id: 'run-3', state: 'stopped' }), false);
    assert.equal(recordSubagentSignal(dir, { ...base, id: 'run-4', state: 'interrupted' }), false);
    const signals = lines(join(dir, 'signals', 'inbox.jsonl')).map(line => parseSignal(JSON.parse(line)));
    assert.deepEqual(signals.map(s => [s.kind, s.severity, s.attention, s.dedupeKey]), [
      ['subagent.completed', 'info', 'notify', 'subagent:run-1'],
      ['subagent.failed', 'warning', 'notify', 'subagent:run-2'],
    ]);
    assert.match(signals[0].summary, /^completed em 10s: Review the pull request$/);
  });
});
