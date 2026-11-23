import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { killRefusal } from '../src/kill-guard.ts';

test('refuses foreign and uncertain targets without executing them', async () => {
  for (const command of ['kill 1', `kill ${process.pid}`, 'kill -- -1', 'kill 0', 'kill $PID', 'pkill -f node', 'killall node', '/bin/kill 1', 'sudo kill 1']) {
    assert.match(await killRefusal(command) ?? '', /Não executado/, command);
  }
  assert.equal(await killRefusal('kill -l'), undefined);
  assert.equal(await killRefusal('kill -0 1'), undefined);
  assert.equal(await killRefusal('echo kill 1'), undefined);
});

test('permits a literal child PID when ancestry is observable', { skip: process.platform !== 'linux' }, async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); process.stdin.resume();"]);
  try {
    await once(child.stdout!, 'data');
    assert.equal(await killRefusal(`kill -TERM ${child.pid}`), undefined);
  } finally {
    child.stdin!.end();
    await once(child, 'exit');
  }
});

test('the bash tool_call hook blocks the kill of an unrelated process', async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  registerEffectApprovals({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI, { enabled: false });
  const result = await hooks.get('tool_call')!({ toolName: 'bash', input: { command: 'kill 1' } }, { cwd: '/tmp', sessionManager: { getSessionId: () => 'test' } });
  assert.equal(result?.block, true);
});
