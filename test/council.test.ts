import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisorLine, advisorPrompt, pickAdvisor } from '../src/council.ts';

const now = Date.parse('2026-11-19T03:00:00Z');
const later = now + 86_400_000;
const state = (usage: Record<string, number>, cooldowns: Record<string, number> = {}) => ({
  usageByProvider: Object.fromEntries(Object.entries(usage).map(([id, used]) => [id, { primary: { usedPercent: used, resetAt: later } }])),
  exhaustedUntilByProvider: cooldowns,
});

test('the advisor is the least used Codex account, never Claude itself', () => {
  const pick = pickAdvisor(state({ 'anthropic-account-2': 2, 'openai-codex': 30, 'openai-codex-account-2': 5 }), now);
  assert.deepEqual(pick, { account: 'openai-codex-account-2', model: 'openai-codex-account-2/gpt-6.1-terra', used: 5 });
});

test('a blocked or exhausted account never advises; none left means no council', () => {
  assert.equal(pickAdvisor(state({ 'openai-codex': 100 }), now), undefined);
  assert.equal(pickAdvisor(state({ 'openai-codex': 1 }, { 'openai-codex': later }), now), undefined);
  assert.equal(pickAdvisor(state({ 'anthropic-account-2': 0 }), now), undefined);
  assert.equal(pickAdvisor({}, now), undefined);
});

test('the prompt carries the candidates and asks for a pick, an objection and a gap, in Portuguese', () => {
  const prompt = advisorPrompt('1. radar quieto (4/5)\n2. funil usdentai (5/5)');
  assert.match(prompt, /funil usdentai/);
  assert.match(prompt, /objeção/);
  assert.match(prompt, /português/i);
});

test('every post names who spoke', () => {
  assert.equal(advisorLine({ account: 'openai-codex', model: 'openai-codex/gpt-6.1-terra', used: 0 }, 'Fico com o 2.'),
    '🤖 *gpt-6.1-terra · openai-codex* (conselheiro): Fico com o 2.');
});
