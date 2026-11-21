import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// external: Git treats files containing literal NUL bytes as binary.

test('tracked text sources contain no NUL byte', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'src', 'test', 'scripts'], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => /\.(ts|mjs|js|json|md)$/.test(f));
  assert.ok(files.length > 10);
  const bad = files.filter((f) => readFileSync(f).includes(0));
  assert.deepEqual(bad, []);
});

// external: Pi throws on a stale extension ctx after reload; a surviving timer can crash the process.


export function staleCtxTimers(file: string, source: string): string[] {
  const clearedOnShutdown = /session_shutdown/.test(source);
  return [...source.matchAll(/set(?:Timeout|Interval)\(\s*(?:async\s*)?\(\)\s*=>[^\n;]*\b(?:ctx|show\(ctx\))\b/g)]
    .filter(() => !clearedOnShutdown).map(m => `${file}: ${m[0].slice(0, 60)}`);
}

test('the stale-ctx detector flags a timer that reaches ctx without a shutdown handler', () => {
  assert.equal(staleCtxTimers('a.ts', 'setTimeout(() => ctx.ui.notify("x"), 5)').length, 1);
  assert.equal(staleCtxTimers('a.ts', 'setInterval(async () => show(ctx), 5)').length, 1);
  assert.equal(staleCtxTimers('a.ts', 'setTimeout(() => ctx.ui.notify("x"), 5); pi.on("session_shutdown", stop)').length, 0);
  assert.equal(staleCtxTimers('a.ts', 'setTimeout(() => redraw(), 5)').length, 0);
});

test('no source file schedules a ctx-touching timer without a session_shutdown handler', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'src'], { encoding: 'utf8' }).split('\0').filter(f => f.endsWith('.ts'));
  assert.ok(files.length > 10);
  assert.deepEqual(files.flatMap(f => staleCtxTimers(f, readFileSync(f, 'utf8'))), []);
});
