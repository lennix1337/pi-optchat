import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { WAKE_RESTORE_FILE, wakeOff, wakeOn, type WakeHost } from '../src/wake-model.ts';

type M = { provider: string; id: string };
const opus: M = { provider: 'anthropic-account-2', id: 'claude-opus-5-5' };
const sonnet: M = { provider: 'anthropic-account-2', id: 'claude-sonnet-5-5' };
const wake = { provider: 'anthropic-account-2', model: 'claude-sonnet-5-5', thinking: 'medium' as ThinkingLevel };

function host(available: M[], refuse = false) {
  const state = { model: opus as M | undefined, thinking: 'high' as ThinkingLevel, notes: [] as string[] };
  const h: WakeHost<M> = {
    current: () => state.model,
    find: (provider, id) => available.find(m => m.provider === provider && m.id === id),
    setModel: async model => { if (refuse) return false; state.model = model; return true; },
    thinking: () => state.thinking,
    setThinking: level => { state.thinking = level; },
    notify: text => { state.notes.push(text); },
  };
  return { h, state };
}
const dir = () => mkdtempSync(join(tmpdir(), 'optchat-wake-'));

test('a wake switches to the wake model and the settle puts the main model and effort back', async () => {
  const d = dir(), { h, state } = host([opus, sonnet]);
  await wakeOn(d, wake, h);
  assert.deepEqual([state.model, state.thinking], [sonnet, 'medium']);
  assert.ok(existsSync(join(d, WAKE_RESTORE_FILE)));
  await wakeOff(d, h);
  assert.deepEqual([state.model, state.thinking], [opus, 'high']);
  assert.equal(existsSync(join(d, WAKE_RESTORE_FILE)), false);
});

test('a reload in the middle of a wake still restores the main model: the record is on disk, not in memory', async () => {
  const d = dir(), first = host([opus, sonnet]);
  await wakeOn(d, wake, first.h);
  const reloaded = host([opus, sonnet]);
  reloaded.state.model = sonnet; reloaded.state.thinking = 'medium';
  await wakeOff(d, reloaded.h);
  assert.deepEqual([reloaded.state.model, reloaded.state.thinking], [opus, 'high']);
});

test('a second wake while still switched keeps the first record, so the main model is what comes back', async () => {
  const d = dir(), { h, state } = host([opus, sonnet]);
  await wakeOn(d, wake, h);
  await wakeOn(d, wake, h);
  await wakeOff(d, h);
  assert.deepEqual(state.model, opus);
});

test('an unavailable wake model leaves the main model on, with no record and a notice', async () => {
  const d = dir(), { h, state } = host([opus]);
  await wakeOn(d, wake, h);
  assert.deepEqual(state.model, opus);
  assert.equal(existsSync(join(d, WAKE_RESTORE_FILE)), false);
  assert.match(state.notes[0]!, /unavailable/);
});

test('no wake model, or nothing recorded: nothing changes', async () => {
  const d = dir(), { h, state } = host([opus, sonnet]);
  await wakeOn(d, undefined, h);
  await wakeOff(d, h);
  assert.deepEqual([state.model, state.thinking, state.notes], [opus, 'high', []]);
});

test('a failed switch back keeps the record so the next settle retries', async () => {
  const d = dir(), first = host([opus, sonnet]);
  await wakeOn(d, wake, first.h);
  const stuck = host([opus, sonnet], true);
  stuck.state.model = sonnet;
  await wakeOff(d, stuck.h);
  assert.ok(existsSync(join(d, WAKE_RESTORE_FILE)));
  assert.match(stuck.state.notes[0]!, /Could not switch back/);
});

// pi-multi-account fails over to another provider when an account runs out of quota, possibly in the middle of a wake.
test('a failover to another provider during the wake stands: no switch back to the exhausted one, and the record goes', async () => {
  const sol: M = { provider: 'openai-codex', id: 'gpt-6.1-sol' };
  const d = dir(), { h, state } = host([opus, sonnet, sol]);
  await wakeOn(d, wake, h);
  state.model = sol; state.thinking = 'xhigh';
  await wakeOff(d, h);
  assert.deepEqual([state.model, state.thinking, state.notes], [sol, 'xhigh', []]);
  assert.equal(existsSync(join(d, WAKE_RESTORE_FILE)), false);
});

test('a rotation to another account of the family during the wake brings the main model back on that account', async () => {
  const opus1: M = { provider: 'anthropic', id: 'claude-opus-5-5' };
  const d = dir(), { h, state } = host([opus1, opus, sonnet, { provider: 'anthropic', id: 'claude-sonnet-5-5' }]);
  state.model = opus1;
  await wakeOn(d, { ...wake, provider: 'anthropic' }, h);
  state.model = sonnet;
  await wakeOff(d, h);
  assert.deepEqual([state.model, state.thinking], [opus, 'high']);
});

test('a Codex wake goes to the lighter model and back to the main one on the same account', async () => {
  const sol: M = { provider: 'openai-codex-account-2', id: 'gpt-6.1-sol' };
  const terra: M = { provider: 'openai-codex-account-2', id: 'gpt-6.1-terra' };
  const d = dir(), { h, state } = host([sol, terra]);
  state.model = sol; state.thinking = 'xhigh';
  await wakeOn(d, { provider: 'openai-codex-account-2', model: 'gpt-6.1-terra', thinking: 'medium' }, h);
  assert.deepEqual([state.model, state.thinking], [terra, 'medium']);
  await wakeOff(d, h);
  assert.deepEqual([state.model, state.thinking], [sol, 'xhigh']);
});
