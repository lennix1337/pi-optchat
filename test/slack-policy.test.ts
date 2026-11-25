import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as policy from '../src/slack-policy.ts';
import { DEFAULT_WORD_BUDGET, words, wordBudget } from '../src/slack-policy.ts';

test('the DM and project channels share a 100-word default; a channel override wins', () => {
  assert.equal(DEFAULT_WORD_BUDGET, 100);
  assert.equal(wordBudget(null), 100, 'the DM');
  assert.equal(wordBudget('dentai'), 100, 'a channel without an override');
  assert.equal(wordBudget('dentai', { dentai: 60 }), 60);
  assert.equal(wordBudget(null, { dentai: 60 }), 100, 'an override never changes the DM');
});

test('words counts whitespace-separated tokens, line breaks included', () => {
  assert.equal(words(''), 0);
  assert.equal(words('  um\ndois\t três  '), 3);
});

test('a post over the budget still goes out whole: no head, pointer or thread reply', () => {
  assert.ok(!('fitPost' in policy), 'nothing splits a post');
});

test('the budget note teaches the scannable contract and still comes off a message title', () => {
  const note = policy.budgetNote(100);
  assert.match(note, /\*\*negrito\*\*/, 'bold key sentence');
  assert.match(note, /\[PR #42\]\(url\)/, 'named links, not bare URLs');
  assert.match(note, /^\(Responda em até 100 palavras, numa mensagem só/);
  const title = `e o deploy?\n\n${note}`;
  assert.equal(policy.withoutBridgeNotes(title), 'e o deploy?');
  assert.equal(policy.withoutBridgeNotes('oi\n\n(Responda em até 100 palavras, numa mensagem só.)'), 'oi', 'older notes still match');
  assert.equal(policy.withoutBridgeNotes('oi\n\n(Responda em até 60 palavras; o que passar disso vai para a thread.)'), 'oi');
});
