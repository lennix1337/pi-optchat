import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelChoice } from '../src/compactor.ts';
import { defaults, loadConfig, saveConfig, wakeModelFor, wakeRoutes, type ProfileConfig } from '../src/profiles.ts';
import { knownProviders, pickWakeRoute } from '../src/wake-route.ts';

const NOW = Date.parse('2026-11-10T15:00:00Z'), HOUR = 3_600_000;
const haiku: ModelChoice = { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'low' };
const spark: ModelChoice = { provider: 'openai-codex', model: 'gpt-5.5-mini', thinking: 'low' };
const config = (extra: Partial<ProfileConfig> = {}): ProfileConfig => ({ ...defaults, wakeModel: [haiku, spark], ...extra });
const codexMain = { provider: 'openai-codex', model: 'gpt-5.5' };
const ids = (routes: ModelChoice[]) => routes.map(r => `${r.provider}/${r.model}`);

test('wake routes: the main account first, its family next, other families last; wakeModelFor stays the main account only', () => {
  const routes = wakeRoutes(config(), codexMain, ['openai-codex-account-3', 'openai-codex-account-2', 'openai-codex', 'anthropic', 'anthropic-account-2', 'google']);
  assert.deepEqual(ids(routes), ['openai-codex/gpt-5.5-mini', 'openai-codex-account-2/gpt-5.5-mini', 'openai-codex-account-3/gpt-5.5-mini', 'anthropic/claude-haiku-5-5', 'anthropic-account-2/claude-haiku-5-5']);
  assert.deepEqual(wakeModelFor(config(), codexMain), { ...spark });
  assert.deepEqual(ids(wakeRoutes(config(), { provider: 'openai-codex-account-2', model: 'gpt-5.5' }, ['openai-codex', 'openai-codex-account-2'])),
    ['openai-codex-account-2/gpt-5.5-mini', 'openai-codex/gpt-5.5-mini', 'anthropic/claude-haiku-5-5']);
});

test('wake routes: a family without a wake model keeps the main model and its thinking on every account; across families can be switched off', () => {
  const only = config({ wakeModel: haiku });
  assert.deepEqual(wakeRoutes(only, codexMain, ['openai-codex-account-2'], 'high'), [
    { provider: 'openai-codex', model: 'gpt-5.5', thinking: 'high' }, { provider: 'openai-codex-account-2', model: 'gpt-5.5', thinking: 'high' }, haiku]);
  assert.deepEqual(ids(wakeRoutes(config({ wakeRouteAcrossFamilies: false }), codexMain, [])), ['openai-codex/gpt-5.5-mini']);
  assert.deepEqual(wakeRoutes(config({ wakeModel: undefined }), undefined, ['openai-codex']), [], 'no main model and no wake model: nothing to route');
  assert.deepEqual(ids(wakeRoutes(config(), undefined, [])), ['anthropic/claude-haiku-5-5', 'openai-codex/gpt-5.5-mini']);
});

test('wakeRouteAcrossFamilies is read from config.json: true by default, false kept, anything else refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-config-'));
  try {
    saveConfig(dir, defaults);
    assert.equal(loadConfig(dir).wakeRouteAcrossFamilies, undefined);
    saveConfig(dir, { ...defaults, wakeRouteAcrossFamilies: false });
    assert.equal(loadConfig(dir).wakeRouteAcrossFamilies, false);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaults, wakeRouteAcrossFamilies: 'no' }));
    assert.throws(() => loadConfig(dir), /Invalid profile config/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the first route that is free wins; with every route out, the earliest comeback is named', () => {
  const routes = wakeRoutes(config(), codexMain, ['openai-codex-account-2']);
  const out = { exhaustedUntilByProvider: { 'openai-codex': NOW + 5 * HOUR } };
  assert.deepEqual(pickWakeRoute(routes, {}, {}, NOW)?.choice, { ...spark }, 'nothing cached: the main account');
  assert.equal(pickWakeRoute(routes, out, {}, NOW)?.choice?.provider, 'openai-codex-account-2', 'the main account is out: its sibling');
  assert.equal(pickWakeRoute(routes, { exhaustedUntilByProvider: { ...out.exhaustedUntilByProvider, 'openai-codex-account-2': NOW + 6 * HOUR } }, {}, NOW)?.choice?.provider, 'anthropic', 'the family is out: the other family');
  const every = { exhaustedUntilByProvider: { 'openai-codex': NOW + 5 * HOUR, 'openai-codex-account-2': NOW + 6 * HOUR, anthropic: NOW + 3 * HOUR } };
  const none = pickWakeRoute(routes, every, {}, NOW);
  assert.equal(none?.choice, undefined);
  assert.equal(none?.until, NOW + 3 * HOUR);
  assert.match(none?.why ?? '', /^openai-codex\/gpt-5.5-mini até .*; openai-codex-account-2\/gpt-5.5-mini até .*; anthropic\/claude-haiku-5-5 até /);
  const closed = wakeRoutes(config({ wakeRouteAcrossFamilies: false }), codexMain, ['openai-codex-account-2']);
  assert.equal(pickWakeRoute(closed, { exhaustedUntilByProvider: { 'openai-codex': NOW + 5 * HOUR, 'openai-codex-account-2': NOW + 6 * HOUR } }, {}, NOW)?.until, NOW + 5 * HOUR, 'only the main family: the other family does not rescue it');
  assert.equal(pickWakeRoute(closed, { exhaustedUntilByProvider: { 'openai-codex': NOW + 5 * HOUR, 'openai-codex-account-2': NOW + 6 * HOUR } }, {}, NOW)?.choice, undefined);
});

test('a provider blocked by a failed wake is skipped even when the cache calls it free; unpublished routes and no routes decide nothing', () => {
  const routes = wakeRoutes(config(), codexMain, []);
  assert.equal(pickWakeRoute(routes, { usageByProvider: { 'openai-codex': { fetchedAt: NOW, serviceable: true } } }, { 'openai-codex': NOW + HOUR }, NOW)?.choice?.provider, 'anthropic');
  assert.equal(pickWakeRoute(routes, {}, { 'openai-codex': NOW - 1 }, NOW)?.choice?.provider, 'openai-codex', 'an ended block counts for nothing');
  assert.equal(pickWakeRoute(routes, {}, {}, NOW, choice => choice.provider === 'anthropic')?.choice?.provider, 'anthropic');
  assert.equal(pickWakeRoute(routes, { exhaustedUntilByProvider: { anthropic: NOW + HOUR } }, {}, NOW, choice => choice.provider === 'anthropic')?.until, NOW + HOUR, 'only published routes are counted');
  assert.equal(pickWakeRoute(routes, {}, {}, NOW, () => false), undefined);
  assert.equal(pickWakeRoute([], {}, {}, NOW), undefined);
});

test('the accounts a wake could be routed across come from the cached file and the failed-wake blocks', () => {
  assert.deepEqual(knownProviders({ usageByProvider: { a: {} }, exhaustedUntilByProvider: { b: 1, a: 2 } }, { c: 3 }).sort(), ['a', 'b', 'c']);
  assert.deepEqual(knownProviders(null), []);
  assert.deepEqual(knownProviders({ usageByProvider: [1, 2] }), []);
});
