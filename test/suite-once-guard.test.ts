import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSuiteOnceGuard, runsSuite } from '../src/suite-once-guard.ts';

const setup = () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  registerSuiteOnceGuard({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } });
  const run = (command: string, toolName = 'bash') => hooks.get('tool_call')!({ toolName, input: { command } });
  return { hooks, run };
};

test('recognises full-suite commands and ignores focused checks', () => {
  for (const command of ['npm test', 'npm run verify', 'cd x && npm run test 2>&1 | tail -3', 'node --test "test/*.test.ts"'])
    assert.equal(runsSuite({ name: 'bash', arguments: { command } }), true, command);
  for (const command of ['node --test test/a.test.ts', 'npm run lint:comments', 'npm run check', 'npm test:unit'])
    assert.equal(runsSuite({ name: 'bash', arguments: { command } }), false, command);
});

test('the first suite runs, the second is refused once, the retry passes', () => {
  const { run } = setup();
  assert.equal(run('npm test'), undefined);
  assert.match(run('npm run verify').reason, /^Não executado:.*suíte/);
  assert.equal(run('npm run verify'), undefined);
});

test('a new input or a wake report starts a new run', () => {
  const { hooks, run } = setup();
  run('npm test');
  assert.equal(run('npm test').block, true);
  hooks.get('input')!({ text: 'next' });
  assert.equal(run('npm test'), undefined);
  assert.equal(run('npm test').block, true);
  hooks.get('before_agent_start')!({ messageType: 'custom', message: { customType: 'optchat-report' } });
  assert.equal(run('npm test', 'shell_start'), undefined);
});
