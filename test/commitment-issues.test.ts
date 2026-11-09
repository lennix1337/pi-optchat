import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ghIssueState, issueReferences, IssueStateCache } from '../src/commitment-issues.ts';
import { commitmentsContext, type Commitment } from '../src/commitments.ts';

test('only flags when every explicit citation is resolved closed', async () => {
  assert.deepEqual(issueReferences('pi-optchat #54 → #55'), [
    { repo: 'lennix1337/pi-optchat', number: 54 }, { repo: 'lennix1337/pi-optchat', number: 55 },
  ]);
  assert.equal(issueReferences('unknown #1'), undefined);
  assert.equal(issueReferences('runtime/fixtures #906'), undefined);
  assert.deepEqual(issueReferences('https://github.com/org/repo/pull/42'), [{ repo: 'org/repo', number: 42 }]);
  const calls: string[] = [];
  const cache = new IssueStateCache(async ref => { calls.push(`${ref.repo}#${ref.number}`); return 'closed'; });
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
  const errors: unknown[] = [], old = console.error;
  console.error = (...args) => { errors.push(args); };
  try { assert.equal(await ghIssueState({ repo: 'org/repo', number: 42 }, async () => { throw new Error('missing gh'); }), undefined); }
  finally { console.error = old; }
  assert.equal(errors.length, 1);
});

test('open, unknown, and ambiguous citations do not flag', async () => {
  assert.equal(issueReferences('pi-optchat and Genexus18MCP #1'), undefined);
  const cache = new IssueStateCache(async ref => ref.number === 1 ? 'closed' : undefined);
  await cache.refresh('pi-optchat #1 #2');
  assert.equal(cache.hint('pi-optchat #1 #2'), undefined);
});

test('every project the operator tracks resolves to its real GitHub repo, not only three', () => {
  const cases: [string, string][] = [
    ['dotfiles #52', 'lennix1337/dotfiles'],
    ['pi-gitwatch PR #23', 'lennix1337/pi-gitwatch'],
    ['pi-subagents #28', 'lennix1337/pi-subagents'],
    ['pi-ripwire #12', 'lennix1337/pi-ripwire-but-better'],
    ['dentai-mono #136', 'tecnologia-ai/dentai'],
    ['pi-goal-x #9', 'lennix1337/pi-goal-x'],
    ['pi-vault #3', 'lennix1337/pi-vault'],
  ];
  for (const [text, repo] of cases) assert.deepEqual(issueReferences(text), [{ repo, number: Number(text.match(/\d+/)![0]) }], text);
  assert.equal(issueReferences('pi-gitwatch and dotfiles #5'), undefined);
});
