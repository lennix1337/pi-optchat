import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { dollars, familyLabel, metaText, mountFooter, tokens } from '../src/footer.ts';

test('money and tokens are short and in Portuguese number format', () => {
  assert.deepEqual([44.93, 3.254, 10, 0].map(dollars), ['$44,9', '$3,25', '$10,0', '$0,00']);
  assert.deepEqual([512, 1_000, 197_432, 1_000_000, 1_450_000].map(tokens), ['512', '1k', '197k', '1M', '1,5M']);
});

test('the goal extension\'s status becomes the meta slot: the unfocused banner counts what is open, any other status is passed on', () => {
  assert.equal(metaText('goal: unfocused [2 open] - /goal-focus'), 'meta: 2 em aberto · /goal-focus');
  assert.equal(metaText('goal: ship the footer'), 'meta: ship the footer');
  assert.equal(metaText('  '), undefined);
  assert.equal(metaText(undefined), undefined);
});

test('the quota label is the account\'s family', () => {
  assert.equal(familyLabel('claude-sonnet-5-5', 'anthropic-account-2'), 'Claude');
  assert.equal(familyLabel('gpt-6.1-sol', 'openai-codex'), 'GPT');
  assert.equal(familyLabel('mystery-1', 'acme'), 'acme');
});

test('without a UI the footer is left to Pi; with one it replaces it and unmounting gives it back', () => {
  const calls: unknown[] = [];
  const ctx = (hasUI: boolean) => ({ hasUI, getContextUsage: () => undefined, model: undefined, ui: { setFooter: (factory: unknown) => calls.push(factory) } }) as unknown as ExtensionContext;
  const sources = { spend: () => 1, quotaState: () => ({}) };
  mountFooter(ctx(false), sources)();
  assert.deepEqual(calls, [], 'no UI, no footer call');
  const unmount = mountFooter(ctx(true), sources);
  assert.equal(typeof calls[0], 'function');
  unmount();
  assert.equal(calls[1], undefined);
  assert.equal(calls.length, 2);
});
