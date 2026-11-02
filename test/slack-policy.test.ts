import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_WORD_BUDGET, fitPost, words, wordBudget } from '../src/slack-policy.ts';

const POINTER_WORDS = 5;
const sentence = (n: number, tag: string) => Array.from({ length: n }, (_, i) => i === 0 ? tag : 'palavra').join(' ') + '.';

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

test('a post within the budget goes out whole, with no thread reply', () => {
  const text = Array.from({ length: 100 }, () => 'a').join(' ');
  assert.deepEqual(fitPost(text, 100), { head: text });
  assert.deepEqual(fitPost('Feito.', 100), { head: 'Feito.' });
});

test('a post over the budget: a head within the budget, a pointer, and the full text kept for the thread', () => {
  const paragraphs = [sentence(40, 'primeiro'), sentence(40, 'segundo'), sentence(40, 'terceiro')];
  const text = paragraphs.join('\n\n');
  const fitted = fitPost(text, 100);
  assert.equal(fitted.full, text, 'nothing is dropped: the thread gets the whole text');
  assert.ok(words(fitted.head) <= 100, `head has ${words(fitted.head)} words`);
  assert.ok(fitted.head.startsWith(paragraphs[0]!), 'the head starts with the first paragraph');
  assert.ok(fitted.head.includes('texto completo na thread'), 'the pointer says where the rest is');
  assert.ok(!fitted.head.includes('terceiro'), 'a paragraph that does not fit is not cut into the head mid-way');
});

test('a single paragraph over budget is cut at a sentence boundary, not mid-sentence', () => {
  const text = [sentence(30, 'um'), sentence(30, 'dois'), sentence(30, 'tres'), sentence(30, 'quatro')].join(' ');
  const { head } = fitPost(text, 100);
  assert.ok(words(head) <= 100);
  assert.ok(head.startsWith('um '));
  const body = head.split('\n\n')[0]!;
  assert.ok(body.includes('tres ') && body.endsWith('palavra.'), 'the head ends on a whole sentence');
  assert.ok(!head.includes('quatro'), 'the sentence that does not fit is left out, not cut');
});

test('a sentence longer than the room is cut at a word, so the head still says something', () => {
  const text = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
  const { head, full } = fitPost(text, 100);
  assert.equal(full, text);
  assert.ok(words(head) <= 100 && words(head) > 90, `head has ${words(head)} words`);
  assert.ok(head.startsWith('w0 w1 w2'));
});

test('a cut never leaves a code fence open in the head', () => {
  const text = `Veja o diff:\n\n\`\`\`\n${Array.from({ length: 120 }, (_, i) => `linha${i}`).join('\n')}\n\`\`\`\n\nfim`;
  const { head } = fitPost(text, 100);
  assert.equal((head.match(/```/g) ?? []).length % 2, 0, 'the head has whole fences only');
  assert.ok(head.startsWith('Veja o diff:'));
});

test('a budget smaller than the pointer still posts a head (the pointer) and keeps the full text', () => {
  const text = 'uma frase qualquer com algumas palavras';
  const fitted = fitPost(text, 2);
  assert.equal(fitted.full, text);
  assert.ok(words(fitted.head) <= Math.max(2, POINTER_WORDS));
});
