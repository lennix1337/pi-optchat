import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EffectApprovals } from '../src/authorization.ts';

const call = (tool: string, input: unknown, session = 'owner') => ({ session, cwd: '/repo', tool, input });
const bash = (command: string, session = 'owner') => call('bash', { command }, session);
const PUSH = 'git -C C:/projetos/pi-optchat push origin main';

function wait(gate: EffectApprovals, invocation: ReturnType<typeof call>) {
  const refusal = gate.admit(invocation);
  assert.equal(refusal?.block, true, 'the call waits for the operator');
  return gate.pendingFor(invocation.session).find(p => p.token === refusal!.token)!;
}

test('a pending push to main carries its reason, its repository and the exact scope a session allow would cover', () => {
  const gate = new EffectApprovals({ mode: 'risk' });
  const pending = wait(gate, bash(PUSH));
  assert.equal(pending.reason, 'publica commits no remoto');
  assert.deepEqual(pending.targets, ['C:/projetos/pi-optchat']);
  assert.equal(pending.sessionAllow, 'git -C c:/projetos/pi-optchat push origin main');
});

test('every pending call says why it needs the operator, and an edit names its file', () => {
  const gate = new EffectApprovals({ mode: 'all' });
  const edit = wait(gate, call('edit', { path: 'C:\\projetos\\pi-optchat\\src\\a.ts', edits: [] }));
  assert.deepEqual(edit.targets, ['C:/projetos/pi-optchat/src/a.ts']);
  assert.match(edit.reason!, /exige aprovação/);
  assert.equal(edit.sessionAllow, undefined);
});

test('the session tap approves this call and allows only that exact push for the rest of the session', () => {
  const gate = new EffectApprovals({ mode: 'risk' });
  const pending = wait(gate, bash(PUSH));
  assert.equal(gate.allowSessionFromPhone('owner', pending.token), true);
  assert.equal(gate.admit(bash(PUSH)), undefined, 'the approved call runs');
  assert.equal(gate.admit(bash(PUSH)), undefined, 'and so does the same push again, with no new question');
  for (const other of [
    'git -C C:/projetos/dotfiles push origin main',
    'git -C C:/projetos/pi-optchat push --force origin main',
    'git -C C:/projetos/pi-optchat push origin feature',
    'git -C C:/projetos/pi-optchat push origin main; rm -rf /',
    'git push origin main',
  ]) wait(gate, bash(other));
  wait(gate, bash(PUSH, 'other-session'));
  gate.clear();
  wait(gate, bash(PUSH));
});

test('a session allow never covers a deploy, a production write, a third-party message, spending or a force-push', () => {
  const gate = new EffectApprovals({ mode: 'risk' });
  const grant = wait(gate, bash(PUSH));
  assert.equal(gate.allowSessionFromPhone('owner', grant.token), true);
  const never = [
    bash('ssh pc "pwsh -File C:\\\\projetos\\\\dentai-mono\\\\scripts\\\\release\\\\deploy-web.ps1 -Commit abc"'),
    bash('ssh prod "psql -c \'DELETE FROM users\'"'),
    bash('curl -X POST https://graph.facebook.com/v19.0/1/messages -d x'),
    bash('gh pr merge 5 --admin'),
    call('subagent', { action: 'run', agent: 'worker' }),
    bash('git -C C:/projetos/pi-optchat push -f origin main'),
  ];
  for (const invocation of never) {
    const pending = wait(gate, invocation);
    assert.equal(pending.sessionAllow, undefined, `no session scope is offered for ${pending.summary}`);
    assert.equal(gate.allowSessionFromPhone('owner', pending.token), false, 'the session tap approves nothing for it');
    assert.equal(gate.admit(invocation)?.block, true, 'and it still waits, call after call');
  }
});

test('the session tap is refused for an unknown token, another session and a call already decided', () => {
  const gate = new EffectApprovals({ mode: 'risk' });
  const pending = wait(gate, bash(PUSH));
  assert.equal(gate.allowSessionFromPhone('owner', 'f'.repeat(24)), false);
  assert.equal(gate.allowSessionFromPhone('other', pending.token), false);
  assert.equal(gate.admit(bash(PUSH, 'other'))?.block, true);
  assert.equal(gate.decideFromPhone('owner', pending.token, true), true);
  assert.equal(gate.allowSessionFromPhone('owner', pending.token), false, 'already decided once');
  assert.equal(gate.admit(bash(PUSH)), undefined, 'the one-shot approval is consumed');
  wait(gate, bash(PUSH));
});
