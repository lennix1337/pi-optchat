import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function fixture() {
  const hooks = new Map<string, (...args: any[]) => any>();
  registerEffectApprovals({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI, { enabled: false });
  const ctx = (session = 'a') => ({ cwd: '/tmp', sessionManager: { getSessionId: () => session } });
  const call = (command: string, session = 'a') => hooks.get('tool_call')!({ toolName: 'bash', input: { command } }, ctx(session));
  const result = (command: string, text: string, isError = true, session = 'a') => hooks.get('tool_result')?.({ toolName: 'bash', input: { command }, content: [{ type: 'text', text }], isError }, ctx(session));
  return { call, result, hooks, ctx };
}

test('blocks third git am after the same failure, normalizing whitespace', async () => {
  const f = fixture();
  const error = 'error: Patch failed at 0001 change\nCommand exited with code 128';
  assert.equal(await f.call('git am /tmp/x.patch'), undefined);
  f.result('git am /tmp/x.patch', error);
  assert.equal(await f.call('git  am  /tmp/x.patch'), undefined);
  f.result('git  am  /tmp/x.patch', error);
  const refusal = await f.call('git am /tmp/x.patch');
  assert.equal(refusal?.block, true);
  assert.match(refusal.reason, /approach|abordagem/i);
  assert.equal(await f.call('git am /tmp/x.patch', 'other'), undefined);
});

test('scp failures survive other commands and reset only on its own different error or success', async () => {
  const f = fixture();
  const cmd = 'scp file agy-pc:/tmp/file';
  const error = 'scp: dest open "/tmp/file": Failure\nCommand exited with code 1';
  f.result(cmd, error);
  f.result(cmd, 'another failure\nCommand exited with code 1');
  assert.equal(await f.call(cmd), undefined);
  f.result(cmd, error);
  f.result(cmd, error);
  assert.equal((await f.call(cmd))?.block, true);
  assert.equal(await f.call('pwd'), undefined);
  f.result('pwd', '/tmp', false);
  assert.equal((await f.call(cmd))?.block, true);
  f.result(cmd, '', false);
  f.result(cmd, error);
  assert.equal(await f.call(cmd), undefined);
});

test('only the 20 most recent failing commands are remembered per session', async () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.result(`cmd ${i}`, 'failed');
  f.result('cmd 0', 'failed');
  f.result('cmd 20', 'failed');
  assert.equal((await f.call('cmd 0'))?.block, true);
  f.result('cmd 1', 'failed');
  assert.equal(await f.call('cmd 1'), undefined);
});

test('session lifecycle clears repeated failures', async () => {
  const f = fixture();
  f.result('false', 'Command exited with code 1');
  f.result('false', 'Command exited with code 1');
  f.hooks.get('session_start')?.({}, f.ctx());
  assert.equal(await f.call('false'), undefined);
});
