import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRoutes, type Route } from '../src/runtime/account-routes.ts';

const NOW = 1_000_000;
function agentDir(files: Record<string, object>): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-routes-'));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  return dir;
}
const models = (...ids: string[]): Route[] => ids.map(id => { const [provider, model] = id.split('/'); return { provider, model }; });
const available = models('openai-codex/gpt-6.1-sol', 'openai-codex/gpt-6-astra', 'openai-codex-account-2/gpt-6.1-sol', 'openai-codex-account-2/gpt-6-astra',
  'anthropic/claude-opus-5-5', 'anthropic/claude-haiku-5-5', 'anthropic-account-2/claude-opus-5', 'google/gemini-2.5-pro', 'kimi-coding/k2');

test('each logged-in account uses its saved default; Pi\'s default account leads, then the rotation priority', () => {
  const dir = agentDir({
    'settings.json': { defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol' },
    'provider-failover.json': { providerPriority: ['anthropic', 'openai-codex', 'kimi-coding'], pinnedModels: { 'kimi-coding': 'k2' }, includeOtherProviders: false },
    'provider-failover-state.json': { lastSwitches: [
      { from: 'x/y', to: 'anthropic/claude-haiku-5-5', at: 1 },
      { from: 'openai-codex/gpt-6.1-sol', to: 'anthropic/claude-opus-5-5', at: 2 },
    ] },
  });
  try {
    const routes = new AccountRoutes(dir, undefined, () => NOW);
    assert.deepEqual(routes.candidates(available), models(
      'openai-codex/gpt-6.1-sol', // Pi's saved default account first
      'anthropic/claude-opus-5-5', // the rotation's latest choice for the group, not the flagship guess or an older switch
      'openai-codex-account-2/gpt-6.1-sol', // same group as Pi's saved default
      'kimi-coding/k2', // explicit pin
    ));
    // anthropic-account-2 has no claude-opus-5-5 and google is outside the rotation: neither gets an invented model.
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shared rotation cooldowns and the executor\'s own failures skip an account until they expire', () => {
  let now = NOW;
  const dir = agentDir({
    'settings.json': { defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol' },
    'provider-failover.json': { providerPriority: ['openai-codex', 'anthropic'], cooldownMs: 5000, transientCooldownMs: 100 },
    'provider-failover-state.json': { exhaustedUntilByProvider: { 'openai-codex': NOW + 1000 }, lastSwitches: [{ to: 'anthropic/claude-opus-5-5', at: 1 }] },
  });
  try {
    const routes = new AccountRoutes(dir, undefined, () => now);
    assert.deepEqual(routes.candidates(available), models('openai-codex-account-2/gpt-6.1-sol', 'anthropic/claude-opus-5-5'));
    routes.record({ provider: 'anthropic', model: 'claude-opus-5-5' }, 'limit');
    routes.record({ provider: 'openai-codex-account-2', model: 'gpt-6.1-sol' }, 'transient');
    assert.deepEqual(routes.candidates(available), []);
    now = NOW + 1001;
    assert.deepEqual(routes.candidates(available), models('openai-codex/gpt-6.1-sol', 'openai-codex-account-2/gpt-6.1-sol'));
    now = NOW + 5001;
    assert.equal(routes.candidates(available).length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('errors are classified with the rotation\'s patterns; context and unknown errors are not account failures', () => {
  const dir = agentDir({ 'provider-failover.json': { limitErrorPatterns: ['usage limit'], authErrorPatterns: ['credit balance is too low'], ignoreErrorPatterns: ['context window'] } });
  try {
    const routes = new AccountRoutes(dir);
    assert.equal(routes.classify('You have hit your ChatGPT usage limit (team plan)'), 'limit');
    assert.equal(routes.classify('400 Your credit balance is too low to access the Anthropic API'), 'auth');
    assert.equal(routes.classify('503 overloaded'), 'transient');
    assert.equal(routes.classify('usage limit hit: context window exceeded'), null);
    assert.equal(routes.classify('Unexpected token in JSON'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without rotation files only Pi\'s saved default is used', () => {
  const dir = agentDir({ 'settings.json': { defaultProvider: 'anthropic', defaultModel: 'claude-opus-5-5' } });
  try { assert.deepEqual(new AccountRoutes(dir).candidates(available), models('anthropic/claude-opus-5-5')); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
