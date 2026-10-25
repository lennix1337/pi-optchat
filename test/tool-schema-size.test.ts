import { test } from 'node:test';
import assert from 'node:assert/strict';
import Value from 'typebox/value';
import { operationalStateTool } from '../src/operational-tool.ts';

// Every tool definition is sent on every turn: a larger schema costs tokens until the session ends.
const tool = operationalStateTool(() => { throw new Error('unused'); }, () => {});

test('operational_state definition stays small enough to send every turn', () => {
  // 1,992 after the enum trim, plus ~560 for the optional authorization grant (scope/action/allow/until).
  assert.ok(JSON.stringify(tool).length <= 2600, `operational_state definition is ${JSON.stringify(tool).length} characters`);
});

test('operational_state schema still accepts and rejects the same updates', () => {
  const base = { text: 'x', sourceMessageId: '0' };
  const evidence = [{ kind: 'test', ref: 'npm test' }];
  const ok = (update: unknown) => Value.Check(tool.parameters, { update });
  assert.ok(ok({ ...base, kind: 'decision' }));
  assert.ok(ok({ ...base, kind: 'change', evidence }));
  assert.ok(ok({ ...base, kind: 'check', status: 'verified', evidence }));
  assert.ok(ok({ ...base, kind: 'check', status: 'blocked', evidence }));
  assert.ok(!ok({ ...base, kind: 'nonsense' }));
  assert.ok(!ok({ ...base, kind: 'check', evidence }), 'a check needs a status');
  assert.ok(!ok({ ...base, kind: 'check', status: 'verified' }), 'a check needs evidence');
  assert.ok(!ok({ ...base, kind: 'decision', status: 'verified' }), 'only a check has a status');
  assert.ok(!ok({ ...base, kind: 'decision', evidence: [{ kind: 'guess', ref: 'r' }] }));
});
