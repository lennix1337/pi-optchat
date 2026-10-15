import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOperationalState, renderOperationalContext, updateOperationalState, type OperationalUpdate } from '../src/operational-state.ts';

function withDirectory(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'optchat-operational-state-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

const objective: OperationalUpdate = { kind: 'objective', text: 'Finish the authorized test task.', sourceMessageId: 'message-10' };
const evidence = [{ kind: 'self-reported' as const, ref: 'reported by the operator; no test output attached' }];

test('updates are durable, idempotent, and preserve explicit supersession lineage', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const first = updateOperationalState(file, objective);
  const duplicate = updateOperationalState(file, objective);
  assert.equal(first.entries.length, 1);
  assert.equal(duplicate.entries[0]?.id, first.entries[0]?.id);
  assert.deepEqual(readOperationalState(file), first);

  const replacement = updateOperationalState(file, {
    kind: 'objective', text: 'Validate the authorized test task.', sourceMessageId: 'message-11', supersedes: first.entries[0]!.id,
  });
  assert.equal(replacement.entries.length, 2);
  assert.equal(replacement.entries[1]?.supersedes, first.entries[0]?.id);
  const context = renderOperationalContext(replacement);
  assert.match(context, /Validate the authorized test task/);
  assert.doesNotMatch(context, /Finish the authorized test task/);
  assert.match(context, new RegExp(`supersedes=${first.entries[0]!.id}`));
}));

test('source message ID and explicit evidence/status are required at the update boundary', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  assert.throws(() => updateOperationalState(file, { ...objective, sourceMessageId: '' } as OperationalUpdate), /sourceMessageId/);
  assert.throws(() => updateOperationalState(file, { kind: 'check', text: 'It works.', sourceMessageId: 'message-12', status: 'verified' } as OperationalUpdate), /evidence/);
  assert.throws(() => updateOperationalState(file, { kind: 'check', text: 'It works.', sourceMessageId: 'message-12', status: 'implemented', evidence } as unknown as OperationalUpdate), /check status/);
  assert.throws(() => updateOperationalState(file, { kind: 'check', text: 'It works.', sourceMessageId: 'message-12', status: 'verified', evidence } as OperationalUpdate), /self-reported evidence alone/);
  assert.equal(readOperationalState(file).entries.length, 0);
}));

test('a change is never promoted to a verified check without an explicit check record', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const state = updateOperationalState(file, {
    kind: 'change', text: 'Implemented the requested retry guard.', sourceMessageId: 'message-20', evidence,
  });
  assert.deepEqual(state.entries.map(entry => entry.kind), ['change']);
  const context = renderOperationalContext(state);
  assert.match(context, /change id=/);
  assert.doesNotMatch(context, /check:verified/);
  assert.match(context, /evidence \[self-reported; unverified assertion\]/);

  const checked = updateOperationalState(file, {
    kind: 'check', text: 'Retry guard regression test passes.', sourceMessageId: 'message-21', status: 'verified',
    evidence: [{ kind: 'test', ref: 'test/operational-state.test.ts: retry-guard regression' }],
  });
  assert.deepEqual(checked.entries.map(entry => entry.kind), ['change', 'check']);
  assert.match(renderOperationalContext(checked), /check:verified/);
}));

test('decision prose mentioning authorization does not create an authorization record', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const state = updateOperationalState(file, {
    kind: 'decision', text: 'An old note says the action was authorized.', sourceMessageId: 'message-30',
  });
  assert.deepEqual(state.entries.map(entry => entry.kind), ['decision']);
  assert.doesNotMatch(renderOperationalContext(state), /authorization id=/);
}));

test('malformed persisted JSON is rejected and never overwritten by an update', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const damaged = '{"version":1,"entries":[{}]}\n';
  writeFileSync(file, damaged);
  assert.throws(() => readOperationalState(file), /Invalid operational state/);
  assert.throws(() => updateOperationalState(file, objective), /Invalid operational state/);
  assert.equal(readFileSync(file, 'utf8'), damaged);
}));

test('an atomic-write failure propagates without changing the prior state', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const before = updateOperationalState(file, objective);
  const original = readFileSync(file, 'utf8');
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(temporary); // atomicWrite cannot open a directory as its temporary file.
  assert.throws(() => updateOperationalState(file, { kind: 'decision', text: 'Do not lose the earlier state.', sourceMessageId: 'message-40' }));
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual(readOperationalState(file), before);
}));

test('supersession must reference an existing record of the same kind', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const prior = updateOperationalState(file, objective);
  assert.throws(() => updateOperationalState(file, {
    kind: 'decision', text: 'This cannot supersede an objective.', sourceMessageId: 'message-50', supersedes: prior.entries[0]!.id,
  }), /same kind/);
  assert.equal(readOperationalState(file).entries.length, 1);
}));

test('rendering and stored entries stay bounded', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  let state = updateOperationalState(file, objective);
  for (let index = 0; index < 8; index++) state = updateOperationalState(file, {
    kind: 'decision', text: `Keep decision ${index} bounded.`, sourceMessageId: `message-${60 + index}`,
  });
  const rendered = renderOperationalContext(state, 256);
  assert.ok(rendered.length <= 256);
  assert.match(rendered, /TRUNCATED/);
  const minimum = renderOperationalContext(updateOperationalState(file, { kind: 'decision', text: 'x'.repeat(2_000), sourceMessageId: 'message-70' }), 128);
  assert.ok(minimum.length <= 128);
  assert.match(minimum, /TRUNCATED/);
  assert.throws(() => updateOperationalState(file, { ...objective, text: 'x'.repeat(2_001) }), /text/);
}));
