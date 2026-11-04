import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basicPythonRepl } from '../src/python-repl.ts';

test('python started by the harness uses the basic REPL, which exits on a NUL stdin', () => {
  const env: NodeJS.ProcessEnv = {};
  basicPythonRepl(env);
  assert.equal(env.PYTHON_BASIC_REPL, '1');
});

test('an explicit operator choice is kept', () => {
  const env: NodeJS.ProcessEnv = { PYTHON_BASIC_REPL: '' };
  basicPythonRepl(env);
  assert.equal(env.PYTHON_BASIC_REPL, '');
});
