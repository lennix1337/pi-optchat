import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeGrant, grantTargets, latestGrant, orderGrantFor, readOperationalState, renderOperationalContext, scopeCovers, updateOperationalState, type OperationalUpdate } from '../src/operational-state.ts';
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

test('a grant keeps the spelling of its scope, so a Linux checkout can still be read, and still matches in any case', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const state = updateOperationalState(file, scopedGrant('pode pushar', '1', { action: 'push', scope: '/Tmp/Repo-AbC\\', allow: true, until: 'done' }));
  assert.equal(readOperationalState(file).entries[0]!.grant!.scope, '/Tmp/Repo-AbC');
  assert.equal(latestGrant(state, 'push', '/tmp/repo-abc/src')?.grant.allow, true);
}));

test('a grant covers the folder a command acts in, not only the session folder', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const state = updateOperationalState(file, scopedGrant('sim pode remover sempre se ja foi mergeada', '1', { action: 'delete', scope: 'C:/projetos', allow: true, until: 'done' }));
  const grantFor = (command: string) => describeGrant(state, 'discard', { command }, grantTargets({ command }, 'C:/Users/swluc'));
  assert.match(grantFor('cd C:/projetos/Genexus18MCP && git worktree remove worktrees/pr708 && git branch -D pr708-sync')!, /^ALLOWED delete in C:\/projetos /);
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

test("the operator's typed order lifts an ask rule only for the action it names, in a specific scope, while it is fresh", () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const said: Record<string, string> = {
    '86455': 'pode fazer o merge dos dois que tem la e fazer o deploy',
    '2': 'faz o merge mas não o deploy',
    '3': 'sim',
    '4': 'pode fazer o deploy',
  };
  const order = (text: string, source: string, action: 'merge' | 'deploy', scope = 'C:/projetos/dentai-mono'): OperationalUpdate =>
    ({ kind: 'authorization', text, sourceMessageId: source, grant: { action, scope, allow: true, until: 'done' } });
  const dentai = ['c:/projetos/dentai-mono', 'tecnologia-ai/dentai'];
  const lift = (action: string, targets = dentai, at = Date.now()) => orderGrantFor(readOperationalState(file), { action, targets }, id => said[id], at);
  // 2026-10-29: this one sentence took four approval prompts (two merges, a deploy, and its rerun after a failed gate).
  updateOperationalState(file, order(said['86455'], '86455', 'merge'));
  updateOperationalState(file, order(said['86455'], '86455', 'deploy'));
  assert.match(lift('merge')!, /86455/);
  assert.match(lift('deploy')!, /86455/, 'a rerun of the same deploy is covered too');
  assert.equal(lift('deploy', ['c:/projetos/pi-optchat', 'lennix1337/pi-optchat']), undefined, 'another repository is not covered');
  assert.equal(lift('force-push'), undefined, 'actions an order cannot lift stay with the operator');
  assert.equal(lift('deploy', dentai, Date.now() + 13 * 3600_000), undefined, 'an old order does not keep deploying');
  // A quote that does not name the action, or negates it, lifts nothing.
  updateOperationalState(file, order(said['2'], '2', 'deploy'));
  assert.equal(lift('deploy'), undefined, '"não o deploy" is a refusal');
  updateOperationalState(file, order(said['3'], '3', 'deploy'));
  assert.equal(lift('deploy'), undefined, 'a bare "sim" names no deploy');
  // The record must still match what the operator typed, and the scope must name one place.
  updateOperationalState(file, order('pode fazer o deploy', '9', 'deploy'));
  assert.equal(lift('deploy'), undefined, 'source 9 is not an operator message with that text');
  updateOperationalState(file, order(said['4'], '4', 'deploy', 'C:/projetos'));
  assert.equal(lift('deploy'), undefined, 'a scope over every project is too broad to lift an ask');
  updateOperationalState(file, order(said['4'], '4', 'deploy', 'C:/projetos/dentai-mono'));
  assert.match(lift('deploy')!, /record op_/);
}));

test('scope matching ignores separator style, drive case and the Git Bash spelling of a path', () => {
  const scope = 'c:/projetos/dentai-mono';
  for (const target of ['C:\\projetos\\dentai-mono', 'C:\\\\projetos\\\\dentai-mono', '/c/projetos/dentai-mono', 'C:/Projetos/Dentai-Mono/', 'c:/projetos//dentai-mono', 'c:/projetos/dentai-mono/worktrees/x'])
    assert.equal(scopeCovers(scope, target), true, target);
  for (const target of ['c:/projetos/dentai-monox', 'c:/projetos/dentai', 'c:/projetos'])
    assert.equal(scopeCovers(scope, target), false, target);
  assert.equal(scopeCovers('C:\\projetos\\dentai-mono', 'c:/projetos/dentai-mono'), true, 'a backslash scope');
  assert.equal(scopeCovers('/c/projetos/dentai-mono', 'c:/projetos/dentai-mono/x'), true, 'a Git Bash scope');
});

test('one typed order that names both the merge and the deploy lifts both; a later sentence that negates the deploy overrides it', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const said: Record<string, string> = { '86853': 'pode fazer o merge e deploy', '86901': 'faz o merge mas não o deploy' };
  const checkout = ['c:/projetos/dentai-mono', 'tecnologia-ai/dentai'];
  const slugs = (folder: string) => folder === 'c:/projetos/dentai-mono' ? 'tecnologia-ai/dentai' : undefined;
  const lift = (action: string, targets: string[] = checkout, at = Date.now()) =>
    orderGrantFor(readOperationalState(file), { action, targets }, id => said[id], at, slugs);
  // Recorded as the 2026-10-30 order was: one merge grant, quoting the message that also names the deploy.
  updateOperationalState(file, { kind: 'authorization', text: said['86853'], sourceMessageId: '86853', grant: { action: 'merge', scope: 'C:/projetos/dentai-mono', allow: true, until: 'done' } });
  assert.match(lift('merge')!, /86853/);
  assert.match(lift('deploy')!, /86853/, 'the deploy that same sentence names');
  assert.equal(lift('publish'), undefined, 'an action the sentence never names');
  assert.equal(lift('deploy', ['c:/projetos/pi-optchat', 'lennix1337/pi-optchat']), undefined, 'another repository');
  updateOperationalState(file, { kind: 'authorization', text: said['86901'], sourceMessageId: '86901', grant: { action: 'merge', scope: 'C:/projetos/dentai-mono', allow: true, until: 'done' } });
  assert.match(lift('merge')!, /86901/);
  assert.equal(lift('deploy'), undefined, '"não o deploy" in the latest order lifts no deploy');
}));

test('a folder grant lifts an order for the GitHub repo its checkout points at, from any working folder', () => withDirectory(directory => {
  const file = join(directory, 'operational-state.json');
  const said: Record<string, string> = { '86853': 'pode fazer o merge e deploy' };
  const slugs = (folder: string) => folder === 'C:/projetos/dentai-mono' ? 'tecnologia-ai/dentai' : undefined;
  updateOperationalState(file, { kind: 'authorization', text: said['86853'], sourceMessageId: '86853', grant: { action: 'merge', scope: 'C:/projetos/dentai-mono', allow: true, until: 'done' } });
  const state = readOperationalState(file);
  const lift = (targets: string[]) => orderGrantFor(state, { action: 'merge', targets }, id => said[id], Date.now(), slugs);
  assert.match(lift(['c:/users/swluc', 'tecnologia-ai/dentai'])!, /86853/, 'gh pr merge --repo from another folder');
  assert.equal(lift(['c:/users/swluc', 'lennix1337/dentai']), undefined, 'a same-named repository under another owner');
  assert.equal(orderGrantFor(state, { action: 'merge', targets: ['c:/users/swluc', 'tecnologia-ai/dentai'] }, id => said[id], Date.now(), () => undefined), undefined, 'no checkout, no slug to match');
}));
