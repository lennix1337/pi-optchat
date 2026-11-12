import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { addCommitment, commitmentsTool, readCommitments, recordLinkEvent, registerCommitments, updateCommitment } from '../src/commitments.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
const temp = () => mkdtempSync(join(tmpdir(), 'commitment-links-'));
const T0 = Date.parse('2026-11-10T18:00:00Z'); // 15:00 in Brasília
const mergedNotice = (repo: string, pr: number, text = 'merged abc1234') => ({ role: 'custom', customType: 'gitwatch', content: `[gitwatch] ${repo} ${pr}`, display: true,
  details: { repo, events: [{ pr, kind: 'merged', text, wake: true }] } });

/** The extension's hooks on a fake Pi, with the clock under the test's control. */
function hooks(dir: string, clock: { now: number }) {
  const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
  const sent: { message: { customType: string; content: string }; options: { triggerTurn?: boolean } }[] = [];
  const pi = { registerTool: () => {}, on: (name: string, handler: (event: Record<string, unknown>) => unknown) => { handlers.set(name, handler); },
    sendMessage: (message: { customType: string; content: string }, options: { triggerTurn?: boolean }) => { sent.push({ message, options }); } };
  const registered = registerCommitments(pi as never, () => ({ dir, sourceExists: () => true }), () => clock.now);
  return { registered, sent, fire: (name: string, event: Record<string, unknown>) => handlers.get(name)?.(event) };
}
const only = (dir: string, id: string) => readCommitments(dir).find(c => c.id === id)!;

test('links are stored with the commitment, survive a reload of the store and are validated', async () => {
  const dir = temp();
  try {
    const tool = commitmentsTool(() => ({ dir, sourceExists: () => true }));
    const added = await tool.execute('a', { action: 'add', text: 'Merge the fix', source: '1', links: { prs: ['lennix1337/pi-optchat#260'], runs: ['abcd1234'], reload: true, next: 'verify live' } });
    const id = /c_[0-9a-f]{6}/.exec(added.content[0]!.text)![0];
    assert.deepEqual(only(dir, id).links, { prs: ['lennix1337/pi-optchat#260'], runs: ['abcd1234'], reload: true, next: 'verify live' });
    const listed = await tool.execute('b', { action: 'list' });
    assert.match(listed.content[0]!.text, /linked: lennix1337\/pi-optchat#260, run abcd1234, reload/);
    updateCommitment(dir, { id, progress: 'queued auto-merge' }, T0);
    assert.deepEqual(only(dir, id).links?.prs, ['lennix1337/pi-optchat#260'], 'an update that names no links keeps them');
    updateCommitment(dir, { id, links: { prs: ['lennix1337/pi-optchat#261'], reload: false } }, T0);
    assert.deepEqual(only(dir, id).links, { prs: ['lennix1337/pi-optchat#261'], runs: ['abcd1234'], next: 'verify live' }, 'a list replaces its list, reload false clears it');
    updateCommitment(dir, { id, links: { prs: [], runs: [] } }, T0);
    assert.equal(only(dir, id).links, undefined, 'nothing left to wait for: no links');
    await assert.rejects(tool.execute('c', { action: 'add', text: 'x', source: '1', links: { prs: ['pi-optchat#260'] } }), /owner\/repo#N/);
    const file = join(dir, 'commitments.json');
    const document = JSON.parse(readFileSync(file, 'utf8')) as { items: Record<string, unknown>[] };
    writeFileSync(file, JSON.stringify({ ...document, items: [{ ...document.items[0], links: { prs: 7 } }] }));
    assert.throws(() => readCommitments(dir), /Unreadable commitments file/, 'a damaged links field is not trusted');
  } finally { removeDir(dir); }
});

test('a gitwatch merged notice appends exactly one progress line to a linked commitment; a repeat adds none', () => {
  const dir = temp(), clock = { now: T0 };
  try {
    const linked = addCommitment(dir, { text: 'Land #260', source: '1', links: { prs: ['lennix1337/pi-optchat#260'] } }, T0 - 3_600_000);
    const other = addCommitment(dir, { text: 'Land #261', source: '1', links: { prs: ['lennix1337/pi-optchat#261'] } }, T0 - 3_600_000);
    const plain = addCommitment(dir, { text: 'No links', source: '1' }, T0 - 3_600_000);
    const before = readFileSync(join(dir, 'commitments.json'), 'utf8');
    const { fire } = hooks(dir, clock);
    fire('message_end', { message: mergedNotice('lennix1337/pi-optchat', 260) });
    fire('message_end', { message: mergedNotice('lennix1337/pi-optchat', 260) });
    const item = only(dir, linked.id);
    assert.equal(item.notes.length, 1, 'one line for two notices');
    assert.equal(item.notes[0]!.text, 'gitwatch lennix1337/pi-optchat#260: merged abc1234');
    assert.equal(item.notes[0]!.at, new Date(T0).toISOString());
    assert.equal(item.progressAt, new Date(T0).toISOString(), 'the stall clock restarts');
    assert.equal(item.status, 'open', 'the event never closes the item');
    assert.equal(item.evidence, undefined);
    assert.equal(only(dir, other.id).notes.length, 0, 'another PR is not touched');
    assert.deepEqual(only(dir, plain.id), plain, 'an unlinked commitment is untouched');
    assert.notEqual(readFileSync(join(dir, 'commitments.json'), 'utf8'), before);
  } finally { removeDir(dir); }
});

test('a duplicate notice writes nothing to disk, and notices that are not progress are ignored', () => {
  const dir = temp(), clock = { now: T0 };
  try {
    const c = addCommitment(dir, { text: 'Land #260', source: '1', links: { prs: ['lennix1337/pi-optchat#260'] } }, T0);
    const { fire } = hooks(dir, clock);
    const notice = (kind: string, text: string, pr = 260) => ({ message: { role: 'custom', customType: 'gitwatch', details: { repo: 'lennix1337/pi-optchat', events: [{ pr, kind, text, wake: false }] } } });
    fire('message_end', notice('checks', 'checks running (2 pending)'));
    fire('message_end', notice('push', 'new head abc'));
    fire('message_end', notice('merged', 'merged abc', 0));
    fire('message_end', { message: { role: 'custom', customType: 'other', details: { repo: 'lennix1337/pi-optchat', events: [{ pr: 260, kind: 'merged', text: 'merged' }] } } });
    fire('message_end', { message: { role: 'custom', customType: 'gitwatch', details: 'damaged' } });
    assert.equal(only(dir, c.id).notes.length, 0, 'running checks, pushes, branch events, other senders and damaged details add nothing');
    fire('message_end', notice('checks', 'checks failed: build'));
    const written = readFileSync(join(dir, 'commitments.json'), 'utf8');
    fire('message_end', notice('checks', 'checks failed: build'));
    assert.equal(readFileSync(join(dir, 'commitments.json'), 'utf8'), written, 'the duplicate leaves the file as it was');
    fire('message_end', notice('mergeState', 'merge conflict with main'));
    assert.deepEqual(only(dir, c.id).notes.map(n => n.text), ['gitwatch lennix1337/pi-optchat#260: checks failed: build', 'gitwatch lennix1337/pi-optchat#260: merge conflict with main']);
  } finally { removeDir(dir); }
});

test('the link sets next only when it says what comes next, and only when the PR ends', () => {
  const dir = temp();
  try {
    const withNext = addCommitment(dir, { text: 'a', source: '1', next: 'wait for CI', links: { prs: ['o/r#1'], next: 'verify the deploy' } }, T0);
    const without = addCommitment(dir, { text: 'b', source: '1', next: 'wait for CI', links: { prs: ['o/r#1'] } }, T0);
    recordLinkEvent(dir, { type: 'pr', repo: 'o/r', pr: 1, kind: 'checks', text: 'checks failed: lint' }, T0 + 1000);
    assert.equal(only(dir, withNext.id).next, 'wait for CI', 'a failing check is not the end of the PR');
    recordLinkEvent(dir, { type: 'pr', repo: 'O/R', pr: 1, kind: 'merged', text: 'merged abc' }, T0 + 2000);
    assert.equal(only(dir, withNext.id).next, 'verify the deploy');
    assert.equal(only(dir, without.id).next, 'wait for CI', 'no next in the link: next stays');
    assert.equal(only(dir, without.id).status, 'open');
  } finally { removeDir(dir); }
});

test('a merge of a PR whose commitment plans a next step starts a turn, even when gitwatch sent the merge quietly', () => {
  const dir = temp(), clock = { now: T0 };
  try {
    const planned = addCommitment(dir, { text: 'Release 4.5.0', source: '1', links: { prs: ['lennix1337/Genexus18MCP#981'], next: 'rerun release.ps1 -Minor' } }, T0 - 60_000);
    addCommitment(dir, { text: 'Land #982', source: '1', links: { prs: ['lennix1337/Genexus18MCP#982'] } }, T0 - 60_000);
    const { fire, sent } = hooks(dir, clock);
    const quiet = (pr: number, kind: string, text: string) => ({ message: { role: 'custom', customType: 'gitwatch', content: 'x', display: true, details: { repo: 'lennix1337/Genexus18MCP', events: [{ pr, kind, text, wake: false }] } } });
    fire('message_end', quiet(981, 'checks', 'checks failed: lint'));
    assert.equal(sent.length, 0, 'a PR that has not ended starts no turn');
    fire('message_end', quiet(982, 'merged', 'merged def'));
    assert.equal(sent.length, 0, 'a commitment without a planned step starts no turn');
    fire('message_end', quiet(981, 'merged', 'merged 93a1074d'));
    fire('message_end', quiet(981, 'merged', 'merged 93a1074d'));
    assert.equal(sent.length, 1, 'one turn, a repeat starts none');
    assert.equal(sent[0]!.options.triggerTurn, true);
    assert.match(sent[0]!.message.content, new RegExp(`${planned.id}.*merged 93a1074d.*rerun release\\.ps1 -Minor`, 's'));
  } finally { removeDir(dir); }
});

test('a closed commitment is not touched by an event', () => {
  const dir = temp();
  try {
    const c = addCommitment(dir, { text: 'a', source: '1', links: { prs: ['o/r#1'] } }, T0);
    updateCommitment(dir, { id: c.id, status: 'done', evidence: 'merged, seen' }, T0 + 1);
    assert.deepEqual(recordLinkEvent(dir, { type: 'pr', repo: 'o/r', pr: 1, kind: 'merged', text: 'merged abc' }, T0 + 2), []);
    assert.equal(only(dir, c.id).notes.length, 0);
  } finally { removeDir(dir); }
});

test('a worker run that ends appends one line to the commitment linked to it, whatever the state, and never closes it', () => {
  const dir = temp(), clock = { now: T0 };
  try {
    const c = addCommitment(dir, { text: 'Worker 6f5d238e', source: '1', links: { runs: ['6f5d238e'], next: 'review the report' } }, T0 - 1000);
    const unrelated = addCommitment(dir, { text: 'Other run', source: '1', links: { runs: ['deadbeef'] } }, T0 - 1000);
    const { registered } = hooks(dir, clock);
    registered.runEnded({ id: '6f5d238e', state: 'failed' });
    registered.runEnded({ id: '6f5d238e', state: 'failed' });
    const item = only(dir, c.id);
    assert.deepEqual(item.notes.map(n => n.text), ['worker run 6f5d238e failed']);
    assert.equal(item.next, 'review the report');
    assert.equal(item.status, 'open');
    assert.equal(only(dir, unrelated.id).notes.length, 0);
    registered.runEnded({ id: '6f5d238e', state: 'completed' });
    assert.equal(only(dir, c.id).notes.length, 2, 'a resumed run that ends again is new progress');
  } finally { removeDir(dir); }
});

test('the reload resume appends one line to a reload-linked commitment, once per resume', () => {
  const dir = temp(), clock = { now: T0 };
  try {
    const c = addCommitment(dir, { text: 'Verify after reload', source: '1', links: { reload: true, next: 'run the live probe' } }, T0 - 1000);
    const plain = addCommitment(dir, { text: 'No links', source: '1' }, T0 - 1000);
    const { registered } = hooks(dir, clock);
    registered.reloadResumed('a'.repeat(32));
    registered.reloadResumed('a'.repeat(32));
    const item = only(dir, c.id);
    assert.deepEqual(item.notes.map(n => n.text), ['reload done; continuation started']);
    assert.equal(item.next, 'run the live probe');
    assert.equal(item.status, 'open');
    assert.equal(item.links, undefined, 'the reload was awaited once');
    assert.deepEqual(only(dir, plain.id), plain);
  } finally { removeDir(dir); }
});

test('a damaged commitments file never throws into the event hook', () => {
  const dir = temp(), clock = { now: T0 };
  try {
    writeFileSync(join(dir, 'commitments.json'), '{not json');
    const { registered, fire } = hooks(dir, clock);
    assert.doesNotThrow(() => registered.runEnded({ id: 'x', state: 'completed' }));
    assert.doesNotThrow(() => fire('message_end', { message: mergedNotice('o/r', 1) }));
  } finally { removeDir(dir); }
});

test('a worker run that ends reaches the commitments hook through Children', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-links-agents-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions' as const,
    models: [{ id: 'child', name: 'child', reasoning: false, input: ['text' as const], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(m: { id: string; api: string; provider: string }) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      void hold.then(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  } as never);
  const commitments = temp();
  const ended: { id: string; state: string }[] = [];
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async () => {}, () => {}, dir,
    { onRunEnd: run => { ended.push({ id: run.id, state: run.state }); recordLinkEvent(commitments, { type: 'run', id: run.id, state: run.state }); },
      createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    const [id] = await children.spawn([{ task: 'plain task' }], dir);
    const c = addCommitment(commitments, { text: 'Watch the plain run', source: '1', links: { runs: [id!] } }, T0);
    release();
    await (children as any).running.get(id)?.completion;
    assert.deepEqual(ended, [{ id: id!, state: 'completed' }]);
    assert.deepEqual(only(commitments, c.id).notes.map(n => n.text), [`worker run ${id} completed`]);
  } finally { await children.close(); await memory.close(); removeDir(dir); removeDir(commitments); }
});
