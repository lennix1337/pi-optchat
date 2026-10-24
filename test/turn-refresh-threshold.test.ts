import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { subagentCompaction } from '../src/agents.ts';
import { VIEW } from '../src/memory.ts';
import { DEFAULT_SETTINGS, invalid } from '../src/settings.ts';
import { TURN_REFRESHED } from '../src/prompts.ts';
import { estimatedContextTokens, inputTokenBudget } from '../src/run-context.ts';
import { buildContext, refreshBudget, refreshedRun, refreshFraction, refreshPoint } from '../src/transcript.ts';
import { toolCallMessage, toolResultMessage, userMessage } from './messages.ts';

// Turn refresh threshold at 10% on the main model (claude-opus-5-5: 1M window, 128K max output, no price tiers).
// The trigger counts the run's characters at about 4 per token, so 10% moves a turn at about 100K tokens. These tests pin
// that lever. The shipped default stays 30%; 10% is a per-profile or OPTCHAT_REFRESH_AT choice.

const WINDOW = 1_000_000;
const LOW = 0.1;
const MAIN_OUTPUT = 128_000;
const TRIGGER = 400_000; // characters: 0.1 × 1,000,000 × 4
const task = () => userMessage('Do the work.');
/** One tool call and its result, whose text is `chars` long. */
const step = (id: string, chars: number): AgentMessage[] => [toolCallMessage(id, 'read'), toolResultMessage(id, 'read', `${id} `.padEnd(chars, '.'))];
const resultIds = (run: readonly AgentMessage[]) => run.flatMap(m => m.role === 'toolResult' ? [m.toolCallId] : []);

test('10% on a 1M model is a 400,000-character trigger, and OPTCHAT_REFRESH_AT still overrides the profile', () => {
  assert.equal(refreshFraction(LOW, undefined), LOW);
  assert.equal(refreshFraction(LOW, ' '), LOW, 'a blank override is ignored');
  assert.equal(refreshFraction(0.3, '0.1'), LOW, 'the override wins over the profile value');
  assert.equal(refreshFraction(LOW, '0'), 0, 'an override of 0 turns the refresh off');
  assert.equal(refreshBudget(WINDOW, refreshFraction(LOW, undefined)), TRIGGER);
  assert.equal(refreshBudget(WINDOW, refreshFraction(LOW, '0')), undefined);
});

test('the shipped default stays at 30%, and 10% is a valid setting', () => {
  assert.equal(DEFAULT_SETTINGS.refreshAt, 0.3);
  assert.ok(!invalid('refreshAt', LOW));
});

test('below the trigger nothing moves; past it the run cuts at its latest step and the older steps leave', () => {
  const budget = refreshBudget(WINDOW, LOW)!;
  const below: AgentMessage[] = [task(), ...step('a', 150_000), ...step('b', 150_000), ...step('c', 20_000)];
  assert.equal(refreshPoint(below, 0, budget), undefined, 'about 320,000 characters is under the trigger');
  const above: AgentMessage[] = [...below, ...step('d', 150_000)];
  const point = refreshPoint(above, 0, budget);
  assert.equal(point?.cut, 7, 'the cut is the latest assistant step');
  assert.ok(point!.size > TRIGGER, 'the trigger fires once the run passes 400,000 characters');
  const refreshed = refreshedRun(above, point!.cut, TURN_REFRESHED);
  assert.deepEqual(resultIds(refreshed), ['d'], 'the older steps a, b and c are no longer sent');
  assert.deepEqual(refreshed.slice(1), above.slice(7), 'the latest step stays verbatim');
  assert.ok(JSON.stringify(refreshed[0]).includes(TURN_REFRESHED), 'the task carries the refresh note');
});

test('after a refresh the next trigger waits for another 400,000 characters of new growth', () => {
  const budget = refreshBudget(WINDOW, LOW)!;
  const run: AgentMessage[] = [task(), ...step('a', 150_000), ...step('b', 150_000), ...step('c', 20_000), ...step('d', 150_000)];
  const cut = refreshPoint(run, 0, budget)!.cut;
  assert.equal(cut, 7);
  const grown: AgentMessage[] = [...run, ...step('e', 1_000)];
  assert.equal(refreshPoint(grown, cut, budget), undefined, 'the retained step and a small one are far below the trigger');
  const more: AgentMessage[] = [...grown, ...step('f', 200_000)];
  assert.equal(refreshPoint(more, cut, budget), undefined, 'about 351,000 characters since the refresh is still under the trigger');
  const again: AgentMessage[] = [...more, ...step('g', 100_000)];
  assert.equal(refreshPoint(again, cut, budget)?.cut, 13, 'about 451,000 characters since the refresh passes the trigger again');
});

test('a last step over half the trigger goes out verbatim, then the run refreshes once a smaller step follows', () => {
  const budget = refreshBudget(WINDOW, LOW)!;
  const run: AgentMessage[] = [task(), ...step('a', 150_000), ...step('b', 150_000), ...step('big', 250_000)];
  assert.equal(refreshPoint(run, 0, budget), undefined, 'the task and the 250,000-character step are over half the trigger, so nothing moves yet');
  const next: AgentMessage[] = [...run, ...step('c', 1_000)];
  assert.equal(refreshPoint(next, 0, budget)?.cut, 7, 'with the small step latest, the run cuts there on this call');
});

test('the largest request 10% lets through still fits the 1M input budget with a wide margin', () => {
  const budget = refreshBudget(WINDOW, LOW)!;
  const prompt = 'p'.repeat(72_000); // about 18K tokens of system prompt
  const view = `<chat>\n${'v'.repeat(VIEW)}\n</chat>`; // the view at its 128,000-byte cap
  // Worst case that does not refresh: the run sits at the trigger and one parallel step (500,000 characters) is the latest step.
  const run: AgentMessage[] = [task(), ...step('a', 390_000), ...step('big', 500_000)];
  assert.equal(refreshPoint(run, 0, budget), undefined, 'the one big step is over half the trigger, so it is kept as it is');
  const request = buildContext([], run, view, prompt);
  const tokens = estimatedContextTokens(request);
  const inputBudget = inputTokenBudget(WINDOW, MAIN_OUTPUT);
  assert.ok(tokens < inputBudget / 2, `about ${tokens} tokens against a ${inputBudget}-token input budget`);
});

test('subagents at 10% on a 1M model compact at about 148,000 tokens, from their own formula', () => {
  assert.deepEqual(subagentCompaction(WINDOW, LOW, MAIN_OUTPUT), { enabled: true, reserveTokens: 852_000 });
  assert.deepEqual(subagentCompaction(WINDOW, 0.3, MAIN_OUTPUT), { enabled: true, reserveTokens: 652_000 }, 'the 30% baseline is unchanged');
});
