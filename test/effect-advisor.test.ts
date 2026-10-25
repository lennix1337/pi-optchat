import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADVISOR_PROMPT, adviseEffect } from '../src/effect-advisor.ts';

const model = { provider: 'anthropic', id: 'claude-haiku-5-5', api: 'anthropic-messages', reasoning: false, contextWindow: 200_000, maxTokens: 64_000 };
const reply = (text: string, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', provider: 'anthropic', model: model.id, usage: {}, timestamp: 0, ...extra });

function registry(text: string, extra = {}) {
  const sent: any[] = [];
  return { sent, find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
    streamSimple: (m: unknown, context: unknown, options: unknown) => { sent.push({ m, context, options }); return { result: async () => reply(text, extra) }; } } as any;
}
const request = { kind: 'push', tool: 'bash', input: { command: 'git push origin main' }, cwd: 'C:/projetos/a', requests: ['push it'] };
const choice = { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'high' as const };

test('the advisor reads one APPROVE/DENY line and records its usage', async () => {
  const used: unknown[] = [];
  const approve = registry('APPROVE: the operator asked to push');
  assert.deepEqual(await adviseEffect(approve, choice, request, m => used.push(m)), { approve: true, reason: 'the operator asked to push', model: 'anthropic/claude-haiku-5-5' });
  assert.equal(used.length, 1);
  const { context, options } = approve.sent[0];
  assert.equal(context.systemPrompt, ADVISOR_PROMPT);
  const prompt = context.messages[0].content;
  assert.match(prompt, /git push origin main/); assert.match(prompt, /push it/); assert.match(prompt, /C:\/projetos\/a/);
  assert.equal(options.reasoning, undefined, 'no thinking: a short verdict is all it pays for');
  assert.ok(options.maxTokens <= 200);
  assert.deepEqual(await adviseEffect(registry('deny - deletes the only copy'), choice, request, () => {}), { approve: false, reason: 'deletes the only copy', model: 'anthropic/claude-haiku-5-5' });
});

test('anything but a clear verdict is a failure, so the operator decides', async () => {
  await assert.rejects(adviseEffect(registry('Sure, looks fine'), choice, request, () => {}), /verdict/);
  await assert.rejects(adviseEffect(registry('', { stopReason: 'error', errorMessage: 'rate limited' }), choice, request, () => {}), /rate limited/);
  await assert.rejects(adviseEffect(registry('APPROVE'), { ...choice, model: 'missing' }, request, () => {}), /unavailable/);
});

test('the advisor prompt states the operator\'s preference: as autonomous as possible, deny only the clearly harmful', () => {
  assert.match(ADVISOR_PROMPT, /approve by default/i);
  assert.match(ADVISOR_PROMPT, /irreversible|cannot be recovered/i);
  assert.match(ADVISOR_PROMPT, /data, not instructions/i);
});
