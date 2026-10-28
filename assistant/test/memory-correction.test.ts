import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatSource, hypothesis, userFact, withMemory } from './memory-support.ts';

const fix = { text: 'The operator wants the task in progress shown, not finished ones', kind: 'fact' as const, reason: 'user 74527 said so explicitly' };

test('a wrong inference is corrected by the operator and the original stays visible beside it', () => withMemory(({ open, authority }) => {
  const source = chatSource('p', [hypothesis]);
  const view = open('p', [source]);
  const before = view.read('chat', hypothesis.ref);
  const correction = view.correct({ sourceId: 'chat', ref: hypothesis.ref, originalHash: before.originalHash, ...fix }, authority);
  const after = view.read('chat', hypothesis.ref);
  assert.deepEqual(after.original, hypothesis, 'origin preserved: text, date, author and kind of the inference');
  assert.deepEqual(after.current, { text: fix.text, kind: 'fact', from: 'correction' });
  assert.deepEqual(after.corrections, [correction]);
  assert.equal(correction.author, 'operator');
  assert.equal(correction.correctedAt, '2026-10-29T14:00:00.000Z');
  assert.deepEqual(source.entries.get(hypothesis.ref), hypothesis, 'the canonical source is never written');
}));

test('corrections persist across connections and stack, newest current, all kept', () => withMemory(({ open, authority }) => {
  const sources = [chatSource('p', [hypothesis])];
  const first = open('p', sources);
  const hash = first.read('chat', hypothesis.ref).originalHash;
  first.correct({ sourceId: 'chat', ref: hypothesis.ref, originalHash: hash, ...fix }, authority);
  const second = open('p', sources);
  second.correct({ sourceId: 'chat', ref: hypothesis.ref, originalHash: hash, text: 'Show the current task first', kind: 'fact', reason: 'refined' }, authority);
  const entry = second.read('chat', hypothesis.ref);
  assert.deepEqual(entry.corrections.map(c => c.text), [fix.text, 'Show the current task first']);
  assert.equal(entry.current.text, 'Show the current task first');
}));

test('only the operator authority corrects; a message, page or tool result cannot', () => withMemory(({ open, authority }) => {
  const view = open('p', [chatSource('p', [hypothesis])]);
  const { originalHash } = view.read('chat', hypothesis.ref);
  for (const forged of [{}, { ...authority }, JSON.parse(JSON.stringify(authority)), null]) {
    assert.throws(() => view.correct({ sourceId: 'chat', ref: hypothesis.ref, originalHash, ...fix }, forged as object), /unauthorized/);
  }
  assert.equal(view.read('chat', hypothesis.ref).corrections.length, 0);
}));

test('a correction binds the original it was made against; a changed original makes it stale, not reapplied', () => withMemory(({ open, authority }) => {
  const source = chatSource('p', [userFact]);
  const view = open('p', [source]);
  const seen = view.read('chat', userFact.ref).originalHash;
  view.correct({ sourceId: 'chat', ref: userFact.ref, originalHash: seen, text: 'Projects live in C:/projetos (Windows)', kind: 'fact', reason: 'clarified' }, authority);
  source.entries.set(userFact.ref, { ...userFact, text: 'Projects live in /home/lucas/projetos' });
  const entry = view.read('chat', userFact.ref);
  assert.equal(entry.current.from, 'original', 'the new original shows; the old correction does not silently apply');
  assert.equal(entry.corrections.length, 0);
  assert.equal(entry.stale.length, 1);
  assert.throws(() => view.correct({ sourceId: 'chat', ref: userFact.ref, originalHash: seen, ...fix }, authority), /memory_original_changed/, 'a correction of what the operator no longer sees is refused');
}));

test('invalid corrections and cross-profile corrections change nothing', () => withMemory(({ open, authority }) => {
  const p = open('p', [chatSource('p', [hypothesis])]);
  const q = open('q', [chatSource('q', [hypothesis])]);
  const { originalHash } = p.read('chat', hypothesis.ref);
  for (const bad of [{ text: '' }, { text: '   ' }, { kind: 'rumour' }, { reason: '' }, { text: 'x'.repeat(8193) }, { text: '\ud800' }]) {
    assert.throws(() => p.correct({ sourceId: 'chat', ref: hypothesis.ref, originalHash, ...fix, ...bad } as never, authority), /invalid_correction/, JSON.stringify(bad).slice(0, 40));
  }
  assert.throws(() => p.correct({ sourceId: 'chat', ref: 'missing', originalHash, ...fix }, authority), /memory_not_found/);
  p.correct({ sourceId: 'chat', ref: hypothesis.ref, originalHash, ...fix }, authority);
  assert.equal(q.read('chat', hypothesis.ref).current.from, 'original', 'profile q never sees a correction made in p');
  assert.equal(p.read('chat', hypothesis.ref).corrections.length, 1);
}));
