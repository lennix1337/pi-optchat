import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ghIssueState, issueReferences, IssueStateCache } from '../src/commitment-issues.ts';
import { commitmentsContext, type Commitment } from '../src/commitments.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, loadConfig, saveConfig } from '../src/profiles.ts';

test('issue aliases are profile-configured and ambiguous matches fail closed', () => {
  const aliases = { '\\balpha\\b': 'sample/alpha', '\\bbeta\\b': 'sample/beta' };
  assert.equal(issueReferences('alpha #1'), undefined);
  assert.deepEqual(issueReferences('alpha #1', aliases), [{ repo: 'sample/alpha', number: 1 }]);
  assert.equal(issueReferences('alpha beta #1', aliases), undefined);
});

test('profile configuration validates alias patterns and repositories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-aliases-'));
  try {
    saveConfig(dir, { ...defaults, issueAliases: { '\\bdemo\\b': 'sample/repo' } });
    assert.deepEqual(issueReferences('demo #1', loadConfig(dir).issueAliases), [{ repo: 'sample/repo', number: 1 }]);
    saveConfig(dir, { ...defaults, issueAliases: { '[': 'sample/repo' } });
    assert.throws(() => loadConfig(dir), /Invalid profile config/);
    saveConfig(dir, { ...defaults, issueAliases: { demo: '../repo/escape' } });
    assert.throws(() => loadConfig(dir), /Invalid profile config/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const aliases = { '\\bpi-optchat\\b': 'example/pi-optchat', '\\bGenexus18MCP\\b': 'example/project' };

test('only flags when every explicit citation is resolved closed', async () => {
  assert.deepEqual(issueReferences('pi-optchat #54 → #55', aliases), [
    { repo: 'example/pi-optchat', number: 54 }, { repo: 'example/pi-optchat', number: 55 },
  ]);
  assert.equal(issueReferences('unknown #1'), undefined);
  assert.equal(issueReferences('runtime/fixtures #906'), undefined);
  assert.deepEqual(issueReferences('https://github.com/org/repo/pull/42'), [{ repo: 'org/repo', number: 42 }]);
  const calls: string[] = [];
  const cache = new IssueStateCache(async ref => { calls.push(`${ref.repo}#${ref.number}`); return 'closed'; }, Date.now, () => {}, () => aliases);
  const text = 'pi-optchat #54 #55';
  assert.equal(cache.hint(text), undefined);
  await cache.refresh(text);
  assert.match(cache.hint(text)!, /all cited issues closed \(#54 #55\)/);
  assert.equal(calls.length, 2);
  await cache.refresh(text);
  assert.equal(calls.length, 2);
  const item: Commitment = { id: 'c_test', text, source: '1', owner: 'optchat', status: 'open', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), progressAt: new Date(0).toISOString(), notes: [] };
  assert.match(commitmentsContext([item], 1000, c => cache.hint(c.text)), /all cited issues closed/);
});

test('fake gh receives explicit issue API paths and failures stay unknown', async () => {
  const calls: unknown[] = [];
  const fakeGh = async (command: string, args: string[]) => { calls.push([command, args]); return { stdout: 'closed\n' }; };
  assert.equal(await ghIssueState({ repo: 'org/repo', number: 42 }, fakeGh), 'closed');
  assert.deepEqual(calls, [['gh', ['api', 'repos/org/repo/issues/42', '--jq', '.state']]]);
  await assert.rejects(ghIssueState({ repo: 'org/repo', number: 42 }, async () => { throw new Error('missing gh'); }), /missing gh/);
});

test('a failed background lookup goes to the failure sink, never to the terminal the TUI draws on', async () => {
  const printed: unknown[] = [], old = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...args: unknown[]) => { printed.push(args); };
  const failures: [string, unknown][] = [];
  const cache = new IssueStateCache(async () => { throw new Error('network failure'); }, () => 0, (key, error) => failures.push([key, error]), () => aliases);
  try { await cache.refresh('Genexus18MCP #889 #887'); }
  finally { Object.assign(console, old); }
  assert.deepEqual(printed, []);
  assert.deepEqual(failures.map(([key]) => key), ['example/project#889', 'example/project#887']);
  assert.equal(cache.hint('Genexus18MCP #889 #887'), undefined);
});

test('open, unknown, and ambiguous citations do not flag', async () => {
  assert.equal(issueReferences('pi-optchat and Genexus18MCP #1', aliases), undefined);
  const cache = new IssueStateCache(async ref => ref.number === 1 ? 'closed' : undefined, Date.now, () => {}, () => aliases);
  await cache.refresh('pi-optchat #1 #2');
  assert.equal(cache.hint('pi-optchat #1 #2'), undefined);
});

test('several aliases may resolve to the same repository without ambiguity', () => {
  const mapping = { '\\balpha\\b': 'sample/one', '\\bbeta\\b': 'sample/one' };
  assert.deepEqual(issueReferences('alpha beta #5', mapping), [{ repo: 'sample/one', number: 5 }]);
});

test('a commitment waiting on a future due date is not told to close because its cited PR merged', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const base: Commitment = { id: 'c_wait', text: 'dotfiles #185 RSS', source: '1', owner: 'optchat', status: 'open', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), progressAt: new Date(now).toISOString(), notes: [] };
  const hint = () => 'all cited issues closed';
  assert.doesNotMatch(commitmentsContext([{ ...base, due: new Date(now + 3600_000).toISOString() }], now, hint), /all cited issues closed/);
  assert.match(commitmentsContext([{ ...base, due: new Date(now - 3600_000).toISOString() }], now, hint), /all cited issues closed/);
  assert.match(commitmentsContext([base], now, hint), /all cited issues closed/);
});
