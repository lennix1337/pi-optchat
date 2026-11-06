import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wakeEffects, wakeLogPost } from '../src/wake-log.ts';

test('wake report distinguishes missing tool results from confirmed effects', () => {
  const messages = [
    { role: 'assistant', content: [
      { type: 'toolCall', id: 'missing-edit', name: 'edit', arguments: { path: 'C:/projetos/example/a.ts' } },
      { type: 'toolCall', id: 'done-edit', name: 'edit', arguments: { path: 'C:/projetos/example/b.ts' } },
      { type: 'toolCall', id: 'missing-push', name: 'bash', arguments: { command: 'git push origin main' } },
      { type: 'toolCall', id: 'missing-close', name: 'commitments', arguments: { action: 'update', id: 'c_test', status: 'done' } },
    ] },
    { role: 'toolResult', toolCallId: 'done-edit', content: 'ok' },
  ];
  const effects = wakeEffects(messages);
  assert.ok(effects.includes('example: editou b.ts'));
  assert.ok(effects.includes('example: edição de a.ts não confirmada'));
  assert.ok(effects.includes('push (resultado não observado)'));
  assert.ok(effects.includes('compromisso c_test fechado (resultado não observado)'));
  assert.ok(!effects.includes('example: editou a.ts'));
  const post = wakeLogPost({ start: 0, end: 0, steps: 1, messages, report: '' });
  assert.match(post, /\*Efeitos:\*/);
  assert.match(post, /edição de a\.ts não confirmada/);
  assert.doesNotMatch(post, /\*Feito:\*/);
});

test('wake report links a merged PR when the command names its repository', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'm1', name: 'bash', arguments: { command: 'gh pr merge 12 --repo lennix1337/example --squash' } }] },
    { role: 'toolResult', toolCallId: 'm1', content: 'ok' },
  ];
  assert.ok(wakeEffects(messages).includes('merge da <https://github.com/lennix1337/example/pull/12|PR #12>'));
});
