import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexFastPayload } from '../src/agents.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

const dec31 = new Date(2026, 11, 31, 23, 59).getTime(), jan1 = new Date(2027, 0, 1, 0, 1).getTime();

test('Codex workers ask for the fast tier through the last day of the configured year, then stop by themselves', () => {
  assert.deepEqual(codexFastPayload({ input: [] }, 'openai-codex-responses', 2026, dec31), { input: [], service_tier: 'priority' });
  assert.deepEqual(codexFastPayload({ input: [] }, 'openai-codex-responses', 2026, jan1), { input: [] });
});

test('the fast tier is off by default and never touches other providers', () => {
  assert.equal(DEFAULT_SETTINGS.codexFastUntilYear, 0);
  assert.deepEqual(codexFastPayload({ input: [] }, 'openai-codex-responses', 0, dec31), { input: [] });
  assert.deepEqual(codexFastPayload({ messages: [] }, 'anthropic-messages', 2026, dec31), { messages: [] });
});
