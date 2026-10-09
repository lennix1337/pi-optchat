import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { resolveModel } from '../src/compactor.ts';
import { accountGroup, defaults, loadConfig, modelFor, removeAlternate, saveConfig, setAlternate } from '../src/profiles.ts';

const haiku = { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'high' } as const;
const luna = { provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'high' } as const;
const config = { ...defaults, compactor: haiku, subagent: haiku, alternates: { compactor: [luna], subagent: [luna] } };

test('a role uses its alternate while the main model is on that provider, and its own choice otherwise', () => {
  assert.deepEqual(modelFor(config, 'subagent', { provider: 'anthropic', model: 'claude-opus-5-5' }), haiku);
  assert.deepEqual(modelFor(config, 'subagent', { provider: 'openai-codex', model: 'gpt-6.1-sol' }), luna);
  assert.deepEqual(modelFor(config, 'compactor', { provider: 'google', model: 'gemini-3.8-flash' }),
    { provider: 'google', model: 'gemini-3.8-flash', thinking: 'off' }, 'no entry: the main model, at its lowest effort');
  assert.deepEqual(modelFor(config, 'subagent', undefined), haiku);
  assert.deepEqual(modelFor({ ...config, alternates: undefined }, 'subagent', { provider: 'openai-codex', model: 'gpt-6.1-sol' }),
    { provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'off' });
});

test('multi-account numbered accounts: the role follows the account the main model is on', () => {
  // The alternate is configured on the base provider; the live account is a numbered slot.
  assert.deepEqual(modelFor(config, 'compactor', { provider: 'openai-codex-account-2', model: 'gpt-6.1-sol' }),
    { provider: 'openai-codex-account-2', model: 'gpt-6-luna', thinking: 'high' });
  // The role's own provider: its own model on the live account.
  assert.deepEqual(modelFor(config, 'compactor', { provider: 'anthropic-account-3', model: 'claude-opus-5-5' }),
    { provider: 'anthropic-account-3', model: 'claude-haiku-5-5', thinking: 'high' });
  // A pinned alternate account is left as configured while the main model is on the base.
  const pinned = { ...config, alternates: { compactor: [{ ...luna, provider: 'openai-codex-account-5' }] } };
  assert.deepEqual(modelFor(pinned, 'compactor', { provider: 'openai-codex', model: 'gpt-6.1-sol' }), { ...luna, provider: 'openai-codex-account-5' });
  // No entry for the family: the main model itself, on the live account.
  assert.deepEqual(modelFor(config, 'compactor', { provider: 'google-account-2', model: 'gemini-3.8-flash' }),
    { provider: 'google-account-2', model: 'gemini-3.8-flash', thinking: 'off' });
});

test('a numbered account that does not publish the fallback model runs it on the family\'s base account', () => {
  const models = new Map([['openai-codex/gpt-6-luna', { provider: 'openai-codex', id: 'gpt-6-luna' }]]);
  const registry = { find: (provider: string, model: string) => models.get(`${provider}/${model}`) } as unknown as ModelRegistry;
  assert.deepEqual(resolveModel(registry, { provider: 'openai-codex-account-2', model: 'gpt-6-luna', thinking: 'high' }),
    { provider: 'openai-codex', model: models.get('openai-codex/gpt-6-luna') });
  assert.equal(resolveModel(registry, { provider: 'openai-codex-account-2', model: 'gpt-6.1-sol', thinking: 'high' }), undefined);
  assert.equal(resolveModel(registry, { provider: 'google', model: 'gpt-6-luna', thinking: 'high' }), undefined);
});

test('a fallback list keeps one entry per provider family', () => {
  assert.equal(accountGroup('openai-codex-account-2'), 'openai-codex');
  assert.equal(accountGroup('google'), 'google');
  assert.deepEqual(setAlternate([luna], { provider: 'openai-codex-account-2', model: 'gpt-6-luna', thinking: 'xhigh' }),
    [{ provider: 'openai-codex-account-2', model: 'gpt-6-luna', thinking: 'xhigh' }], 'the family is replaced, not duplicated');
  assert.deepEqual(setAlternate([luna], haiku), [luna, haiku]);
  assert.deepEqual(removeAlternate([luna, haiku], haiku), [luna]);
  assert.deepEqual(removeAlternate(undefined, haiku), []);
});

test('alternates survive a save and load, and a bad alternate is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-alt-'));
  saveConfig(dir, config);
  assert.deepEqual(loadConfig(dir).alternates, config.alternates);
  saveConfig(dir, defaults);
  assert.equal(loadConfig(dir).alternates, undefined);
  const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...raw, alternates: { subagent: [{ provider: 'x', model: 'y', thinking: 'huge' }] } }));
  assert.throws(() => loadConfig(dir), /Invalid profile config/);
});
