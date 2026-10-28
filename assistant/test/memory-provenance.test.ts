import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdownFactSource } from '../src/memory/projection.ts';
import { chatSource, hypothesis, summary, userFact, withMemory } from './memory-support.ts';

test('a read shows the original with its date, author and kind, telling fact, summary and hypothesis apart', () => withMemory(({ open }) => {
  const view = open('p', [chatSource('p', [hypothesis, userFact, summary])]);
  const kinds = [userFact, summary, hypothesis].map(o => {
    const entry = view.read('chat', o.ref);
    assert.deepEqual(entry.original, o, 'the original is shown as the source holds it');
    assert.deepEqual(entry.current, { text: o.text, kind: o.kind, from: 'original' });
    assert.deepEqual([entry.profileId, entry.sourceId, entry.ref], ['p', 'chat', o.ref]);
    return `${entry.original.author}:${entry.current.kind}`;
  });
  assert.deepEqual(kinds, ['user:fact', 'compactor:summary', 'assistant:hypothesis']);
}));

test('the view copies nothing: the source stays the authority for the text', () => withMemory(({ open }) => {
  const source = chatSource('p', [userFact]);
  const view = open('p', [source]);
  source.entries.set(userFact.ref, { ...userFact, text: 'Projects live in D:/work' });
  assert.equal(view.read('chat', userFact.ref).original.text, 'Projects live in D:/work');
  source.entries.delete(userFact.ref);
  assert.throws(() => view.read('chat', userFact.ref), /memory_not_found/);
}));

test('profiles and sources are isolated: no cross-profile source, no lookup across sources', () => withMemory(({ open }) => {
  assert.throws(() => open('p', [chatSource('q', [userFact])]), /memory_profile_mismatch/, 'a source of profile q cannot be mounted in p');
  assert.throws(() => open('p', [chatSource('p', []), chatSource('p', [], 'chat')]), /invalid_options/, 'duplicate source ids');
  const p = open('p', [chatSource('p', [userFact]), chatSource('p', [hypothesis], 'about-me')]);
  const q = open('q', [chatSource('q', [{ ...userFact, text: 'q only' }])]);
  assert.throws(() => p.read('about-me', userFact.ref), /memory_not_found/, 'a ref is looked up only in its own source');
  assert.throws(() => p.read('mail', userFact.ref), /memory_not_found/);
  assert.equal(q.read('chat', userFact.ref).original.text, 'q only');
  assert.equal(p.read('chat', userFact.ref).original.text, userFact.text);
}));

test('a source answering with a malformed or mislabelled original is refused, not shown', () => withMemory(({ open }) => {
  const view = open('p', [chatSource('p', [{ ...userFact, kind: 'rumour' as 'fact' }, { ...summary, ref: 'other' }])]);
  assert.throws(() => view.read('chat', userFact.ref), /memory_source_invalid/);
  const lying = { sourceId: 'lying', profileId: 'p', get: () => userFact };
  assert.throws(() => open('p', [lying]).read('lying', 'not-74514'), /memory_source_invalid/, 'an original must carry the ref that was asked for');
}));

test('ABOUT-ME bullets are durable operator facts addressed by line, read from the file each time', () => withMemory(({ dir, open }) => {
  const path = join(dir, 'ABOUT-ME.md');
  writeFileSync(path, '# About me\n\n- Lives in Brazil\n- Main projects: dentai-mono and Genexus18MCP\nplain text\n');
  const view = open('p', [markdownFactSource({ path, sourceId: 'about-me', profileId: 'p', author: 'user' })]);
  const entry = view.read('about-me', 'ABOUT-ME.md#L4');
  assert.deepEqual([entry.original.text, entry.original.author, entry.original.kind], ['Main projects: dentai-mono and Genexus18MCP', 'user', 'fact']);
  assert.ok(Number.isFinite(Date.parse(entry.original.observedAt)));
  for (const ref of ['ABOUT-ME.md#L1', 'ABOUT-ME.md#L5', 'ABOUT-ME.md#L99', 'ABOUT-ME.md#L0', 'OTHER.md#L3', 'ABOUT-ME.md#L3x']) {
    assert.throws(() => view.read('about-me', ref), /memory_not_found/, ref);
  }
  writeFileSync(path, '# About me\n\n- Lives in Portugal\n');
  assert.equal(view.read('about-me', 'ABOUT-ME.md#L3').original.text, 'Lives in Portugal');
}));
