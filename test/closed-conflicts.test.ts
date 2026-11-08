import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { cited, cleanClosedOnce, closedConflictsOf, dropClosed, fromRecords, CLOSED_FILE } from '../src/closed-conflicts.ts';
import { dropCarried, foreignIds } from '../src/carried-ids.ts';
import { createCompressor } from '../src/compactor.ts';
import { Memory } from '../src/memory.ts';
import { updateOperationalState } from '../src/operational-state.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

// The swlucas05 profile's list, as shipped in its closed-conflicts.json.
const GIT = [
  { id: 'git-free-87165', match: 'no[- ]?Git|(?<!\\d)(90167|16384)(?!\\d)[^;]{0,40}(Git|push)', say: 'User 87165 replaced the "no Git" rule: Git is free; only release/deploy need permission.' },
  { id: 'git-ok-87165', match: '\\b(w/o|without|no)\\s+(specific\\s+)?OK\\b', with: 'merg|push|commit|\\bPR\\b|squash', say: 'Git actions need no OK since 87165.' },
];
const list = fromRecords(GIT);
const gitwatch = fromRecords([JSON.parse(readFileSync(new URL('./fixtures/closed-conflicts-gitwatch.json', import.meta.url), 'utf8'))]);

test('gitwatch closed authority claims are flagged without suppressing real gates', () => {
  const positives = [
    '134272-399 OptChat: #201 316464c auto-merged via gitwatch: UNRESOLVED (user 131799/132648)',
    'pi-optchat #207, #208 merged via self-queued auto-merge on gitwatch notices (order vs 131799 UNRESOLVED)',
    '#213 abe9d67 turn-start --help merged 135539 (order vs 131799 UNRESOLVED)',
    'dotfiles #58 squash-merged b95cf000 (136081) on gitwatch CLEAN notice (machine), no operator OK; order vs user 131799 UNRESOLVED',
    'Merge order (131799) UNRESOLVED.',
    'PR #42 self-merged w/o order.',
    'PR #42 auto-merged via gitwatch notice UNRESOLVED.',
    'PR #42 self-merged on gitwatch CLEAN, no operator OK.',
  ];
  const negatives = [
    'DentAI #136 deploy 96fdb84e asked, NOT done',
    'prod writes w/o OK UNRESOLVED',
    'PR #944 merged b0a741cf',
    'PR #42 merged; deploy order vs 131799 UNRESOLVED',
    'PR #42 merged with CI not green UNRESOLVED',
    'PR #42 merged; a separate database conflict is UNRESOLVED',
  ];
  for (const line of positives) assert.equal(cited(line, gitwatch).length, 1, line);
  for (const line of negatives) assert.equal(cited(line, gitwatch).length, 0, line);
});
// Real lines from the 31/10 view.
const LINE = 'OptChat 97144-51: gh pr merge 46 --squash returned rc=0 after a gitwatch CLEAN notice, with no specific OK; 90167 no-Git vs pushes UNRESOLVED. ILSpy: KBObject.cs:1134 stub; cap UNVERIFIED (96451). KB-write auth 88064 vs user 95899 UNVERIFIED.';

test('a line citing the closed Git conflict is flagged; open conflicts are not', () => {
  assert.deepEqual(cited(LINE, list).map(c => c.id), ['git-free-87165', 'git-ok-87165']);
  assert.deepEqual(cited('KB-write auth 88064 vs user 95899 UNVERIFIED; CapTest5 undeleted, no OK for the KB write.', list), []);
  assert.deepEqual(cited('Pushes 8fc030f disputed (user 16384 \'no Git\').', list).map(c => c.id), ['git-free-87165']);
  assert.deepEqual(cited('dotfiles 5365256 vs user16384 \'no push\'.', list).map(c => c.id), ['git-free-87165']);
});

test('the fallback drops only what cites it', () => {
  const kept = dropClosed(LINE, list);
  assert.deepEqual(cited(kept, list), []);
  assert.match(kept, /KBObject\.cs:1134/);
  assert.match(kept, /88064 vs user 95899 UNVERIFIED/);
  assert.equal(dropClosed('Merged #12 (no specific OK).', list), 'Merged #12.');
});

test('a superseded operational record closes its source id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-closed-'));
  try {
    const file = join(dir, 'operational-state.json');
    const old = updateOperationalState(file, { kind: 'decision', text: 'no push', sourceMessageId: '16384' }).entries[0];
    updateOperationalState(file, { kind: 'decision', text: 'Git is free', sourceMessageId: '87165', supersedes: old.id });
    writeFileSync(join(dir, CLOSED_FILE), JSON.stringify(GIT));
    const closed = closedConflictsOf(dir)();
    assert.equal(closed.length, 3);
    assert.deepEqual(cited('decision 16384 UNRESOLVED', closed).map(c => c.id), [old.id]);
    assert.deepEqual(cited('message 16384 was read', closed), []);
  } finally { removeDir(dir); }
});

async function compressorWith(replies: string[], conflicts = list) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-closed-c-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  const sent: string[] = [];
  let calls = 0;
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(m, context) {
      const last = context.messages.at(-1);
      sent.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content));
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: replies[Math.min(calls++, replies.length - 1)] }], api: m.api, provider: m.provider, model: m.id,
        timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), undefined, undefined, [0, 0],
    undefined, undefined, undefined, () => conflicts);
  return { dir, sent, calls: () => calls, compress };
}

test('the compactor asks again when a line cites a closed conflict, and keeps the clean one', async () => {
  const { dir, sent, calls, compress } = await compressorWith(['user: merged #46 w/o OK; 90167 no-Git UNRESOLVED.', 'user: merged #46.']);
  try {
    const line = await compress({ context: '<chat>\n</chat>', source: `user: ${'a long message '.repeat(60)}`, part: { l: 0, i: 0 } }, new AbortController().signal);
    assert.equal(line, 'user: merged #46.');
    assert.equal(calls(), 2);
    assert.match(sent[1], /already closed:\n- User 87165 replaced/);
  } finally { removeDir(dir); }
});

test('a model that keeps citing it gets the citation stripped after three tries', async () => {
  const { dir, calls, compress } = await compressorWith(['user: merged #46; 90167 no-Git UNRESOLVED.']);
  try {
    const line = await compress({ context: '<chat>\n</chat>', source: `user: ${'a long message '.repeat(60)}`, part: { l: 0, i: 0 } }, new AbortController().signal);
    assert.equal(line, 'user: merged #46;');
    assert.equal(calls(), 3);
  } finally { removeDir(dir); }
});

test('gitwatch output is retried with the profile correction', async () => {
  const stale = 'PR #42 auto-merged via gitwatch notice UNRESOLVED.';
  const fixture = await compressorWith([stale, 'PR #42 auto-merged via gitwatch notice.'], gitwatch);
  try {
    const input = { context: '', source: 'source '.repeat(100), part: { l: 1, i: 0 } };
    assert.equal(await fixture.compress(input, new AbortController().signal), 'PR #42 auto-merged via gitwatch notice.');
    assert.match(fixture.sent[1], /watcher notices, not the operator/);
  } finally { removeDir(fixture.dir); }
});

test('shown lines citing a closed conflict are rewritten once, and the rewrite survives a reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-closed-m-'));
  const asked: string[] = [];
  const long = `merge #46; 90167 no-Git UNRESOLVED. ${'details '.repeat(80)}`;
  const compress = async (input: { source: string; revise?: string }) => {
    if (input.revise === undefined) return 'user: merge #46; 90167 no-Git UNRESOLVED.';
    asked.push(input.revise); return input.source.replace(/; 90167 no-Git UNRESOLVED\./, '.');
  };
  try {
    const directory = join(dir, 'memory');
    let memory = new Memory(directory, compress, () => {});
    memory.append('user', long);
    memory.append('user', 'the old rule: no Git.');
    await memory.settle(AbortSignal.timeout(2000), 'tree');
    const before = memory.size;
    assert.equal(await cleanClosedOnce(dir, memory, list), 1);
    assert.equal(asked.length, 1, 'a short message is its own line, the user\'s exact words, and stays');
    assert.match(asked[0], /User 87165 replaced/);
    assert.equal(memory.render().includes('no-Git'), false);
    assert.match(memory.render(), /1\+1\|user: the old rule: no Git\./);
    assert.equal(memory.size, before - Buffer.byteLength('; 90167 no-Git UNRESOLVED'), 'the view budget counts the shorter line');
    assert.equal(await cleanClosedOnce(dir, memory, list), 0, 'done once per list');
    const view = memory.render();
    await memory.close();
    memory = new Memory(directory, async () => { throw new Error('nothing to rebuild'); }, () => {});
    assert.equal(memory.render(), view, 'the revision record wins on load');
    assert.equal(memory.zoom(0, 1), `0+1|user: ${long}`, 'the original message is untouched');
    await memory.close();
  } finally { removeDir(dir); }
});

// Real leaf 104353 (03/11): a shell result line that carried three approvals and two message ids from other lines.
const SHELL = 'work: [shell 13b6174f] completed · exit 0 · App Home tests pass 13, fail 0; without src 2 fail; tsc rc=0.';
const CARRIED = 'work: shell 13b6174f: App Home tests 13/0 with fix, 2 fail without src; tsc rc=0. Home "livre" cause (103394, 104291) UNVERIFIED. Approvals 38f9c222, 44d5f68c, 8266855f still open.';

test('ids a one-message line copied from other lines are named; its own are not', () => {
  assert.deepEqual(foreignIds(CARRIED, [SHELL]), ['103394', '104291', '38f9c222', '44d5f68c', '8266855f']);
  assert.deepEqual(foreignIds('tool: ship.mjs merged 02eab54 (#95); c_bb4b18 open.', ['02eab547aa merged', 'c_bb4b18']), [], 'a hash prefix and a named commitment are its own');
  assert.equal(dropCarried(CARRIED, foreignIds(CARRIED, [SHELL])), 'work: shell 13b6174f: App Home tests 13/0 with fix, 2 fail without src; tsc rc=0.');
});

test('the compactor asks once more when a leaf copies ids from <chat>, then strips them', async () => {
  const { dir, sent, calls, compress } = await compressorWith([CARRIED, CARRIED]);
  try {
    const line = await compress({ context: '<chat>\n</chat>', source: `${SHELL} ${'output '.repeat(80)}`, part: { l: 0, i: 104353 } }, new AbortController().signal);
    assert.equal(line, 'work: shell 13b6174f: App Home tests 13/0 with fix, 2 fail without src; tsc rc=0.');
    assert.equal(calls(), 2);
    assert.match(sent[1], /names 103394, 104291, 38f9c222, 44d5f68c, 8266855f, which <input> does not mention/);
  } finally { removeDir(dir); }
});

test('a merge of two lines may name what its lines name', async () => {
  const { dir, calls, compress } = await compressorWith(['104352-353: shell 13b6174f 13/0; approvals 38f9c222 open.']);
  try {
    const line = await compress({ context: '<chat>\n</chat>', source: `${'line '.repeat(80)}`, part: { l: 1, i: 52176 } }, new AbortController().signal);
    assert.match(line, /38f9c222/);
    assert.equal(calls(), 1);
  } finally { removeDir(dir); }
});
