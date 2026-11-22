import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipeStatusRefusal } from '../src/pipe-status-guard.ts';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

for (const command of ['npm test 2>&1 | tail -5; echo rc=$?', 'make | grep -E "error"; echo "rc=$?"', 'cd x && node a.mjs | head -3 && echo rc=$?'])
  test(`refuses ${command}`, () => assert.match(pipeStatusRefusal(command) ?? '', /PIPESTATUS/));

for (const command of ['npm test 2>&1 | tail -5; echo rc=${PIPESTATUS[0]}', 'npm test; echo rc=$?', 'ls | head -3', 'git status | head -4 && node t.mjs > log 2>&1; echo rc=$?'])
  test(`allows ${command}`, () => assert.equal(pipeStatusRefusal(command), undefined));

test('the bash tool_call hook blocks the tail-then-rc pattern before it runs', async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  registerEffectApprovals({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI, { enabled: false });
  const call = (command: string) => hooks.get('tool_call')!({ toolName: 'bash', input: { command } }, { cwd: '/tmp', sessionManager: { getSessionId: () => 'test' } });
  const blocked = await call('npm test | tail -3; echo rc=$?');
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /PIPESTATUS/);
  assert.equal(await call('npm test | tail -3; echo rc=${PIPESTATUS[0]}'), undefined);
});
