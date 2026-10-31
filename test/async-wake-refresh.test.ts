import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { TURN_REFRESHED } from '../src/prompts.ts';
import { buildContext, lastStep, refreshedRun, refreshPoint, textContent } from '../src/transcript.ts';
import { customMessage, toolCallMessage, toolResultMessage, userMessage } from './messages.ts';

// A background wake can start a run whose only input is a hidden custom message (no user message). The refresh helpers
// must treat that message as the current task, or the run grows until the request overflows.

const assistant = (id: string) => toolCallMessage(id, 'read');
const result = (id: string, text: string) => toolResultMessage(id, 'read', text);
const pair = (id: string, text: string): AgentMessage[] => [assistant(id), result(id, text)];
const hidden = (text: string, customType = 'bg-done') => customMessage(customType, text, false);
const BUDGET = 1000;
const OLD = 'OLD-OUTPUT '.repeat(120);

test('a custom-only wake run refreshes: the latest assistant is the cut and the old exchange moves out', () => {
  const notice = hidden('Background job 7 finished.'), policy = hidden('Keep results private.', 'policy');
  const run: AgentMessage[] = [notice, ...pair('old', OLD), policy, ...pair('new', 'small')];
  assert.equal(lastStep(run), 4);
  const point = refreshPoint(run, 0, BUDGET);
  assert.equal(point?.cut, 4);
  const refreshed = refreshedRun(run, point!.cut, TURN_REFRESHED);
  assert.ok(!JSON.stringify(refreshed).includes('OLD-OUTPUT'), 'the old exchange is no longer sent');
  assert.deepEqual(refreshed.slice(1), [policy, ...run.slice(4)], 'live customs and the whole latest pair stay exact');
  const task = refreshed[0];
  assert.ok(task.role === 'custom' && task.customType === 'bg-done' && task.display === false);
  assert.deepEqual(task.content, [{ type: 'text', text: 'Background job 7 finished.' }, { type: 'text', text: `\n\n${TURN_REFRESHED}` }]);
  assert.equal(run[0], notice, 'the original run is not mutated');
  assert.ok(notice.role === 'custom' && notice.content === 'Background job 7 finished.');
});

test('the refreshed custom-only run is a valid request that still holds the view and the hidden notice', () => {
  const run: AgentMessage[] = [hidden('Background job 7 finished.'), ...pair('old', OLD), ...pair('new', 'small')];
  const refreshed = refreshedRun(run, refreshPoint(run, 0, BUDGET)!.cut, TURN_REFRESHED);
  const [head, first, ...rest] = buildContext([], refreshed, '<chat>\n0+1|summary of the old step\n</chat>', 'p');
  assert.equal(head.role, 'system');
  const text = textContent(first.role === 'custom' ? first.content : undefined);
  assert.ok(text.startsWith('<chat>\n0+1|summary of the old step'));
  assert.match(text, /Extension event \(bg-done\), not a new user instruction or authorization:/);
  assert.ok(text.includes('Background job 7 finished.') && text.includes(TURN_REFRESHED));
  assert.deepEqual(rest.map(m => m.role), ['assistant', 'toolResult']);
});

test('a user correction in a wake run stays exact; the wake stays the task, so the note goes on it', () => {
  const notice = hidden('Background job 7 finished.'), correction = userMessage('Correction: do not publish.');
  const run: AgentMessage[] = [notice, ...pair('old', OLD), correction, ...pair('new', 'small')];
  const point = refreshPoint(run, 0, BUDGET);
  assert.equal(point?.cut, 4);
  const refreshed = refreshedRun(run, point!.cut, TURN_REFRESHED);
  assert.ok(!JSON.stringify(refreshed).includes('OLD-OUTPUT'));
  assert.ok(refreshed[0].role === 'custom' && JSON.stringify(refreshed[0].content).includes('Background job 7 finished.') && JSON.stringify(refreshed[0].content).includes(TURN_REFRESHED));
  assert.equal(refreshed[1], correction, 'the correction is kept word for word');
  assert.deepEqual(refreshed.slice(2), run.slice(4));
});

test('a user-backed run behaves as before: the first user message is the task, customs only follow it', () => {
  const task = userMessage('Do the work.'), policy = hidden('Keep results private.', 'policy');
  const run: AgentMessage[] = [policy, task, ...pair('old', OLD), ...pair('new', 'small')];
  assert.equal(lastStep(run), 4);
  const refreshed = refreshedRun(run, 4, TURN_REFRESHED);
  assert.equal(refreshed[0], policy);
  assert.deepEqual(refreshed[1], { ...task, content: [{ type: 'text', text: 'Do the work.' }, { type: 'text', text: `\n\n${TURN_REFRESHED}` }] });
  assert.deepEqual(refreshed.slice(2), run.slice(4));
  assert.equal(refreshPoint([task, ...pair('old', OLD), ...pair('new', 'small')], 0, BUDGET)?.cut, 3);
});

test('an incomplete tool exchange is cut at its call, so the old pair leaves and the pending call stays last', () => {
  const run: AgentMessage[] = [hidden('Background job 7 finished.'), ...pair('old', OLD), assistant('pending')];
  const point = refreshPoint(run, 0, BUDGET);
  assert.equal(point?.cut, 3);
  const refreshed = refreshedRun(run, point!.cut, TURN_REFRESHED);
  assert.deepEqual(refreshed.slice(1), [run[3]]);
  assert.ok(!JSON.stringify(refreshed).includes('OLD-OUTPUT'));
  assert.equal(refreshedRun(run, 0, TURN_REFRESHED).length, run.length, 'keep 0 changes nothing');
});

test('the budget rules hold for a custom task: off, under budget, already cut, and a last step too big to keep', () => {
  const run: AgentMessage[] = [hidden('Background job 7 finished.'), ...pair('old', OLD), ...pair('new', 'small')];
  assert.equal(refreshPoint(run, 0, undefined), undefined);
  assert.equal(refreshPoint(run, 0, 0), undefined);
  assert.equal(refreshPoint(run, 0, 100_000), undefined, 'under the budget nothing moves');
  assert.equal(refreshPoint(run, 3, BUDGET), undefined, 'a run already cut at the last step has nothing newer to move');
  const bigLast: AgentMessage[] = [hidden('Background job 7 finished.'), ...pair('old', OLD), ...pair('new', 'x'.repeat(600))];
  assert.equal(refreshPoint(bigLast, 0, BUDGET), undefined, 'the task and last step must fit in half the budget');
  assert.equal(refreshPoint([hidden('x'.repeat(600)), ...pair('old', OLD), ...pair('new', 'small')], 0, BUDGET), undefined, 'the custom task counts toward that half');
});

test('a run with no user or custom message has no task: nothing to cut or refresh, and no context is built', () => {
  const run: AgentMessage[] = [...pair('old', OLD), ...pair('new', 'small')];
  assert.equal(lastStep(run), 0);
  assert.equal(refreshPoint(run, 0, BUDGET), undefined);
  assert.deepEqual(refreshedRun(run, 2, TURN_REFRESHED), run);
  assert.equal(lastStep([]), 0);
  assert.throws(() => buildContext([], run, '<chat>\n</chat>', 'p'), /no current input message/);
});
