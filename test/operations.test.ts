import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationJournal } from '../src/operations.ts';

test('interruption after execution leaves an uncertain operation and prevents repetition after reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operations-'));
  const first = new OperationJournal(dir);
  first.start('session', 'push-1', 'bash', { command: 'git push', token: 'secret-token' });
  // Execution happened, but its result was never delivered to the journal.
  const reopened = new OperationJournal(dir);
  assert.equal(reopened.pending().length, 1);
  assert.match(reopened.blockReason('bash') ?? '', /uncertain/i);
  assert.equal(reopened.blockReason('read'), undefined);
  assert.equal(reopened.blockReason('operation_state'), undefined);
  assert.throws(() => reopened.resolve('session:push-1', ''), /evidence/i);
  reopened.resolve('session:push-1', 'Read remote ref abc using independent readback, transcript message 12');
  assert.equal(new OperationJournal(dir).blockReason('bash'), undefined);
  assert.doesNotMatch(readFileSync(join(dir, 'operations.json'), 'utf8'), /secret-token|git push/);
});

test('a recorded response is not a verified external outcome and IDs are session-scoped', () => {
  const journal = new OperationJournal(mkdtempSync(join(tmpdir(), 'operations-')));
  journal.start('a', '1', 'write', { path: 'sensitive' });
  journal.finish('a', '1', false);
  journal.start('b', '1', 'write', { path: 'other' });
  assert.equal(journal.pending().length, 1);
  assert.equal(journal.pending()[0].id, 'b:1');
  assert.equal(journal.snapshot()[0].status, 'response_recorded');
  assert.equal(journal.snapshot()[0].outcome, 'not_verified');
});

test('error responses stay uncertain and settling one session does not stop another', () => {
  const journal = new OperationJournal(mkdtempSync(join(tmpdir(), 'operations-')));
  journal.start('a', '1', 'bash', { command: 'first' });
  journal.start('b', '1', 'bash', { command: 'second' });
  journal.settled('a');
  journal.resolve('a:1', 'Read-only observation shows first action did not complete');
  assert.equal(journal.blockReason('write'), undefined);
  assert.throws(() => journal.resolve('b:1', 'not observed'), /still executing/);
  journal.finish('b', '1', true);
  assert.match(journal.blockReason('write') ?? '', /uncertain/);
  assert.throws(() => journal.start('a', '2', 'bash', {}), /uncertain/);
  journal.resolve('b:1', 'Read-only observation of external state in message 12');
  assert.equal(journal.blockReason('write'), undefined);
});

test('failed response persistence immediately blocks other sessions before the failed session settles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operations-'));
  const journal = new OperationJournal(dir);
  journal.start('child', '1', 'write', {});
  mkdirSync(join(dir, `operations.json.${process.pid}.tmp`));
  assert.throws(() => journal.finish('child', '1', false));
  assert.match(journal.blockReason('write') ?? '', /uncertain/);
  assert.throws(() => journal.start('main', '2', 'write', {}), /uncertain/);
});

test('failed durable intent write leaves in-memory and disk state unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operations-'));
  const journal = new OperationJournal(dir);
  mkdirSync(join(dir, `operations.json.${process.pid}.tmp`));
  assert.throws(() => journal.start('a', '1', 'write', {}));
  assert.deepEqual(journal.snapshot(), []);
  assert.deepEqual(new OperationJournal(dir).snapshot(), []);
});

test('invalid journal fails closed and read tools do not create effect intents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operations-'));
  const journal = new OperationJournal(dir);
  journal.start('a', 'r', 'read', { path: 'x' });
  assert.equal(journal.snapshot().length, 0);
  writeFileSync(join(dir, 'operations.json'), '{"version":1,"operations":[{"id":"bad"}]}');
  assert.throws(() => new OperationJournal(dir), /Invalid operation journal/);
});

test('only empty, interrupted or timed-out error responses leave the outcome unknown', async () => {
  const { outcomeUnknown } = await import('../src/operations.ts');
  const text = (value: string) => [{ type: 'text', text: value }];
  for (const value of ['', 'partial\nCommand timed out after 30 seconds', 'Command aborted', 'Error: socket hang up', 'HTTP 502 Bad Gateway', 'ETIMEDOUT']) {
    assert.equal(outcomeUnknown(text(value)), true, value);
  }
  for (const value of ['partial\nCommand exited with code 124', 'Command exited with code 137']) {
    assert.equal(outcomeUnknown(text(value)), true, value);
  }
  // A completed command whose own output mentions timeouts or uncertainty (grep hits, config keys).
  const completed = ['startup_timeout_sec = 120\n"timeout": 10\n\nCommand exited with code 1', 'src/operations.ts:65: external outcome uncertain\nCommand exited with code 1'];
  for (const value of ['Command exited with code 1', 'Error: Not found (404)', 'AssertionError at line 122', `${'it handles timeout\n'.repeat(50)}${'x'.repeat(500)}\nTests 3 failed`, ...completed]) {
    assert.equal(outcomeUnknown(text(value)), false, value);
  }
  assert.equal(outcomeUnknown(undefined), true);
});

test('terminal native check receipts distinguish test output from an interrupted execution', async () => {
  const { outcomeUnknown } = await import('../src/operations.ts');
  const receipt = (extra: object) => [{ type: 'text', text: JSON.stringify({
    schema: 'pi-ripwire/v1', kind: 'check', status: 'failed', exitCode: 1,
    output: 'handles timeout and interrupted-turn recovery', ...extra,
  }) }];
  assert.equal(outcomeUnknown(receipt({})), false);
  assert.equal(outcomeUnknown(receipt({ status: 'passed', exitCode: 0 })), false);
  for (const exitCode of [124, 137, 143]) assert.equal(outcomeUnknown(receipt({ exitCode })), true);
  assert.equal(outcomeUnknown(receipt({ status: 'timeout' })), true);
  assert.equal(outcomeUnknown(receipt({ exitCode: null })), true);
  assert.equal(outcomeUnknown(receipt({ schema: 'untrusted/v1' })), true);
});

test('a refusal returned before anything ran is an observed outcome even when it mentions timeout or uncertainty', async () => {
  const { outcomeUnknown } = await import('../src/operations.ts');
  const text = (value: string) => [{ type: 'text', text: value }];
  const refusals = [
    '{"status":"error","message":"Invalid timeout: rust-clippy","hint":"use a number of seconds"}',
    'Prior check active or outcome uncertain. Inspect the marker before starting another check.',
    'Invalid timeout: rust-clippy',
  ];
  for (const value of refusals) assert.equal(outcomeUnknown(text(value)), false, value);
  // Real cut-offs, including ones that start like a refusal, still leave the outcome unknown.
  const cutOff = [
    '{"status":"error","message":"check timed out after 600 seconds"}',
    'Invalid response: connection reset by peer',
    'Prior check active, then the process was killed (SIGKILL)',
    'Check running ... timed out after 600 seconds',
    'Check failed: outcome uncertain',
    'Invalid response: HTTP 502',
    'Rejected after dispatch: outcome uncertain',
    'Unsupported response after dispatch: timeout',
    'Not executed: external outcome uncertain for s:c (bash); that earlier call was interrupted or timed out.',
    'Invalid timeout: rust-clippy\nHTTP 502',
    'Prior check active or outcome uncertain. HTTP 503',
    'Invalid timeout: rust-clippy\nprocess terminated',
  ];
  for (const value of cutOff) assert.equal(outcomeUnknown(text(value)), true, value);
});
