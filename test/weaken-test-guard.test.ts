import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerWeakenTestGuard, weakenTestGuard } from '../src/weaken-test-guard.ts';

const edit = (path: string, oldText: string, newText: string) => ({ name: 'edit', arguments: { path, edits: [{ oldText, newText }] } });

test('raising a timeout in a test is refused once; the identical retry passes', () => {
  const guard = weakenTestGuard();
  const call = edit('test/a.test.ts', 'timeout: 1000', 'timeout: 2000');
  assert.match(guard.check(call) ?? '', /^Não executado:.*afrouxa/);
  assert.equal(guard.check(call), undefined);
});

test('adding a skip or a retry to a test is refused', () => {
  assert.match(weakenTestGuard().check(edit('test/a.test.ts', "test('x'", "test.skip('x'")) ?? '', /^Não executado/);
  assert.match(weakenTestGuard().check(edit('src/__tests__/a.ts', 'run()', 'retry(run)')) ?? '', /^Não executado/);
});

test('source files, lower timeouts and unrelated test edits pass', () => {
  const guard = weakenTestGuard();
  assert.equal(guard.check(edit('src/a.ts', 'timeout: 1000', 'timeout: 2000')), undefined);
  assert.equal(guard.check(edit('test/a.test.ts', 'timeout: 2000', 'timeout: 1000')), undefined);
  assert.equal(guard.check(edit('test/a.test.ts', 'equal(a, 1)', 'equal(a, 2)')), undefined);
  assert.equal(guard.check({ name: 'bash', arguments: { command: 'ls' } }), undefined);
});

test('registers on tool_call and blocks with the reason', () => {
  const handlers: Record<string, (event: any, ctx?: any) => any> = {};
  registerWeakenTestGuard({ on: (event, handler) => { handlers[event] = handler; } });
  const result = handlers.tool_call!({ toolName: 'edit', input: { path: 'test/a.test.ts', edits: [{ oldText: 'budget: 5', newText: 'budget: 9' }] } });
  assert.equal(result.block, true);
});
