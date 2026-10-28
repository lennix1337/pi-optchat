import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeGrant, grantTargets, latestGrant, readOperationalState, renderOperationalContext, updateOperationalState, type OperationalUpdate } from '../src/operational-state.ts';
import { withTempDir } from './support.ts';

const withDirectory = (run: (directory: string) => void) => withTempDir('optchat-operational-state-', run);

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

const scopedGrant = (text: string, source: string, grant: { action: 'push' | 'delete'; scope: string; allow: boolean; until: string }): OperationalUpdate =>
  ({ kind: 'authorization', text, sourceMessageId: source, grant });

test('a newer grant with overlapping scope supersedes the older one in queries and the per-turn block', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  updateOperationalState(file, scopedGrant('no Git/push', '1', { action: 'push', scope: 'C:/projetos/x', allow: false, until: 'done' }));
  let state = readOperationalState(file);
  assert.equal(latestGrant(state, 'push', 'C:\\Projetos\\X')?.grant.allow, false);
  state = updateOperationalState(file, scopedGrant('pode pushar tudo', '2', { action: 'push', scope: 'C:/projetos/**', allow: true, until: 'done' }));
  assert.equal(latestGrant(state, 'push', 'c:/projetos/x')?.grant.allow, true);
  assert.equal(latestGrant(state, 'push', 'c:/other/x'), undefined, 'outside the scope no grant applies');
  assert.equal(latestGrant(state, 'delete', 'c:/projetos/x'), undefined, 'a different action is not covered');
  const context = renderOperationalContext(state);
  assert.match(context, /pode pushar tudo/);
  assert.doesNotMatch(context, /no Git\/push/);
  assert.match(describeGrant(state, 'push', { command: 'git push' }, 'C:/projetos/x')!, /^ALLOWED push/);
  assert.equal(describeGrant(state, 'discard', {}, 'C:/projetos/x'), undefined);
}));

test('a grant covers the folder a command acts in, not only the session folder', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const state = updateOperationalState(file, scopedGrant('sim pode remover sempre se ja foi mergeada', '1', { action: 'delete', scope: 'C:/projetos', allow: true, until: 'done' }));
  const grantFor = (command: string) => describeGrant(state, 'discard', { command }, grantTargets({ command }, 'C:/Users/swluc'));
  assert.match(grantFor('cd C:/projetos/Genexus18MCP && git worktree remove worktrees/pr708 && git branch -D pr708-sync')!, /^ALLOWED delete in c:\/projetos /);
  assert.match(grantFor('git -C C:/projetos/pi-optchat branch -D feat/x')!, /^ALLOWED delete/);
  assert.equal(grantFor('git branch -D feat/x'), undefined, 'the home folder is outside the scope');
  // A prose scope never covers a path, so the advisor would never see the grant it describes.
  assert.throws(() => updateOperationalState(file, scopedGrant('sim', '2', { action: 'delete', scope: 'git worktrees whose branch is merged, any project in c:/projetos', allow: true, until: 'done' })), /grant\.scope/);
  assert.throws(() => updateOperationalState(file, scopedGrant('sim', '3', { action: 'push', scope: 'c:/a; c:/b', allow: true, until: 'done' })), /grant\.scope/);
}));

test('a disjoint scope does not supersede, and expired grants disappear from queries and the block', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  updateOperationalState(file, scopedGrant('push repo a', '1', { action: 'push', scope: 'c:/a', allow: true, until: '2030-01-01T00:00:00.000Z' }));
  const state = updateOperationalState(file, scopedGrant('no push to b', '2', { action: 'push', scope: 'c:/b', allow: false, until: 'done' }));
  assert.equal(latestGrant(state, 'push', 'c:/a', Date.parse('2029-01-01T00:00:00.000Z'))?.grant.allow, true);
  assert.equal(latestGrant(state, 'push', 'c:/b')?.grant.allow, false);
  const later = Date.parse('2031-01-01T00:00:00.000Z');
  assert.equal(latestGrant(state, 'push', 'c:/a', later), undefined);
  assert.doesNotMatch(renderOperationalContext(state, 6000, later), /push repo a/);
  assert.match(renderOperationalContext(state, 6000, later), /no push to b/);
}));

test('free-text authorizations still load and render; malformed grants are rejected', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const state = updateOperationalState(file, { kind: 'authorization', text: 'pode commitar', sourceMessageId: '3' });
  assert.equal(state.entries[0]!.grant, undefined);
  assert.match(renderOperationalContext(readOperationalState(file)), /pode commitar/);
  assert.throws(() => updateOperationalState(file, scopedGrant('x', '4', { action: 'push', scope: 'c:/a', allow: true, until: 'tomorrow' })), /until/);
  assert.throws(() => updateOperationalState(file, scopedGrant('x', '4', { action: 'fly' as 'push', scope: 'c:/a', allow: true, until: 'done' })), /action/);
  assert.throws(() => updateOperationalState(file, { kind: 'decision', text: 'x', sourceMessageId: '5', grant: { action: 'push', scope: 'c:/a', allow: true, until: 'done' } } as OperationalUpdate), /grant|authorization/);
}));
