import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepPollRefusal } from '../src/sleep-poll-guard.ts';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

for (const command of ['sleep 30; ps -p 12', 'for i in 1 2 3; do ps -p 12; sleep 5; done', 'until ls out.log; do sleep 2; done', 'sleep 1m'])
  test(`refuses ${command}`, () => assert.match(sleepPollRefusal(command) ?? '', /shell_start/));

for (const command of ['sleep 2; echo ok', 'echo "sleep 60 later"; ls', "cat <<'EOF'\nsleep 99\nEOF", 'ls | head'])
  test(`allows ${command}`, () => assert.equal(sleepPollRefusal(command), undefined));

test('the bash tool_call hook blocks a long sleep before it runs and honours the off switch', async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  registerEffectApprovals({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI, { enabled: false });
  const call = (command: string) => hooks.get('tool_call')!({ toolName: 'bash', input: { command } }, { cwd: '/tmp', sessionManager: { getSessionId: () => 'test' } });
  const blocked = await call('sleep 45; gh pr view 1');
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /shell_start/);
  process.env.OPTCHAT_SLEEP_GUARD = 'off';
  try { assert.equal(await call('sleep 45; gh pr view 1'), undefined); } finally { delete process.env.OPTCHAT_SLEEP_GUARD; }
});
