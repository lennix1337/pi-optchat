import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quietGhTelemetry } from '../src/gh-quiet.ts';

test('gh telemetry is turned off by default so no console window flashes', () => {
  const env: NodeJS.ProcessEnv = {};
  quietGhTelemetry(env);
  assert.equal(env.GH_TELEMETRY, '0');
});

test('an explicit operator choice is kept', () => {
  const a: NodeJS.ProcessEnv = { GH_TELEMETRY: 'log' };
  quietGhTelemetry(a);
  assert.equal(a.GH_TELEMETRY, 'log');
  const b: NodeJS.ProcessEnv = { DO_NOT_TRACK: '1' };
  quietGhTelemetry(b);
  assert.equal(b.GH_TELEMETRY, undefined);
});
