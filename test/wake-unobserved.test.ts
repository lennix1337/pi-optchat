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

test('a wake cut by a provider error is labelled as interrupted, not as having delivered nothing', () => {
  const cut = [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'You have hit your ChatGPT usage limit (team plan).' }];
  const post = wakeLogPost({ start: 0, end: 0, steps: 1, messages: cut, report: '' });
  assert.match(post, /interrompido pelo provedor/);
  assert.doesNotMatch(post, /sem entrega/);
  const idle = [{ role: 'assistant', content: [{ type: 'text', text: 'nada' }], stopReason: 'stop' }];
  assert.match(wakeLogPost({ start: 0, end: 0, steps: 1, messages: idle, report: '' }), /sem entrega/);
});

test('wake report marks a truncated commitment text with an ellipsis', () => {
  const long = 'Corrigir relatório #wakes que afirma edição sem resultado de ferramenta; distinguir efeitos';
  const messages = [
    { role: 'assistant', content: [
      { type: 'toolCall', id: 'long', name: 'commitments', arguments: { action: 'add', text: long } },
      { type: 'toolCall', id: 'short', name: 'commitments', arguments: { action: 'add', text: 'Curto' } },
    ] },
    { role: 'toolResult', toolCallId: 'long', content: 'ok' },
    { role: 'toolResult', toolCallId: 'short', content: 'ok' },
  ];
  const effects = wakeEffects(messages);
  const cut = effects.find(e => e.startsWith('compromisso aberto: Corrigir'));
  assert.ok(cut?.endsWith('…'), cut);
  assert.ok(effects.includes('compromisso aberto: Curto'));
});
