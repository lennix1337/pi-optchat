import { test } from 'node:test';
import assert from 'node:assert/strict';
import { causeClaimGuard, claimsCause, registerCauseClaimGuard } from '../src/cause-claim-guard.ts';

const slack = (text: string) => ({ name: 'slack_send', arguments: { text } });
const bash = (command: string) => ({ name: 'bash', arguments: { command } });

test('an unhedged "achei a causa" report is refused once; the identical retry passes', () => {
  const guard = causeClaimGuard();
  const call = slack('Achei o buraco: o lock fica preso.');
  assert.match(guard.check(call) ?? '', /^Não executado:.*causa/);
  assert.equal(guard.check(call), undefined);
});

test('a gh comment claiming the root cause is refused; a hedged one passes', () => {
  assert.equal(claimsCause(bash('gh issue comment 5 --body "Causa encontrada: o cache"')), true);
  assert.equal(claimsCause(bash('gh issue comment 5 --body "Causa encontrada (hipótese): o cache"')), false);
  assert.equal(claimsCause(slack('Causa achada, não verificado ainda.')), false);
});

test('other calls and unrelated text pass', () => {
  assert.equal(claimsCause(bash('ls causa-achada')), false);
  assert.equal(claimsCause(slack('PR #5 mesclado.')), false);
  assert.equal(claimsCause({ name: 'edit', arguments: { text: 'causa achada' } }), false);
});

test('registers on tool_call and blocks with the reason', () => {
  const handlers: Record<string, (event: any, ctx?: any) => any> = {};
  registerCauseClaimGuard({ on: (event, handler) => { handlers[event] = handler; } });
  const result = handlers.tool_call!({ toolName: 'whatsapp_send', input: { text: 'causa raiz achei a causa' } });
  assert.equal(result?.block, true);
});
