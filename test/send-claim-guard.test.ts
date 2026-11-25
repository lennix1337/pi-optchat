import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendClaimGuard } from '../src/send-claim-guard.ts';

const toolResult = (text: string) => ({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text }], timestamp: 0 } });

test('a DM claiming a deploy is live with no output showing it is refused once, then the same text goes', () => {
  const guard = sendClaimGuard();
  const branch = () => [toolResult('web rollout FAILED; ROLLED_BACK')] as never;
  const text = 'Deploy da landing no ar desde 16:07.';
  const refusal = guard.check('slack_send', { text }, branch) ?? '';
  assert.match(refusal, /^Não enviado: .*"no ar".*Faça agora a checagem/);
  assert.doesNotMatch(refusal, /ou escreva "não verificado"/);
  assert.equal(guard.check('slack_send', { text }, branch), undefined);
});

test('a claim the session output shows, a hedged one, and other tools pass', () => {
  const guard = sendClaimGuard();
  const branch = () => [toolResult('PR #11 MERGED bab615c5'), toolResult('HTTP/2 200')] as never;
  assert.equal(guard.check('slack_send', { text: 'PR #11 mesclado (bab615c5) e o site no ar.' }, branch), undefined);
  assert.equal(guard.check('whatsapp_send', { text: 'Ainda não está no ar.' }, () => [] as never), undefined);
  assert.equal(guard.check('bash', { command: 'echo no ar' }, () => [] as never), undefined);
});

test('a merge the output never showed is refused on WhatsApp too', () => {
  assert.match(sendClaimGuard().check('whatsapp_send', { text: 'O #23 foi mesclado.' }, () => [] as never) ?? '', /"#23 mesclado"/);
});
