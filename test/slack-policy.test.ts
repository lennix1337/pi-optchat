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
