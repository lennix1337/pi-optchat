import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, loadConfig, modelFor, saveConfig } from '../src/profiles.ts';

const haiku = { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'max' } as const;
const luna = { provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'max' } as const;
const config = { ...defaults, compactor: haiku, subagent: haiku, alternates: { compactor: [luna], subagent: [luna] } };

test('a role uses its alternate while the main model is on that provider, and its own choice otherwise', () => {
  assert.deepEqual(modelFor(config, 'subagent', 'anthropic'), haiku);
  assert.deepEqual(modelFor(config, 'subagent', 'openai-codex'), luna);
  assert.deepEqual(modelFor(config, 'compactor', 'openai-codex'), luna);
  assert.deepEqual(modelFor(config, 'subagent', 'google'), haiku);
  assert.deepEqual(modelFor(config, 'subagent', undefined), haiku);
  assert.deepEqual(modelFor({ ...config, alternates: undefined }, 'subagent', 'openai-codex'), haiku);
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
