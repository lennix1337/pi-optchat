import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { cited, cleanClosedOnce, closedConflictsOf, dropClosed, fromRecords, CLOSED_FILE } from '../src/closed-conflicts.ts';
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

async function compressorWith(replies: string[]) {
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
    undefined, undefined, undefined, () => list);
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
