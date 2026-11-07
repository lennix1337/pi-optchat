import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain .mjs script without types
import { intentOf, summarize } from '../scripts/exec-waste.mjs';

const row = (min: number, name: string, target: string, cls = 'ok', ms = 100, extra = {}) =>
  ({ at: new Date(Date.UTC(2026, 10, 7, 3, min)).toISOString(), source: 'tool', name, target, class: cls, ms, ...extra });

test('intent ignores the cd prefix and everything after the second word', () => {
  assert.equal(intentOf(row(0, 'bash', 'cd C:/x && node scripts/ship.mjs -m a --all')), 'bash node scripts/ship.mjs');
  assert.equal(intentOf(row(0, 'read', 'C:/x/a.ts')), 'read C:/x/a.ts');
});

test('bash intent is the command that does the work, not the heredoc, cd or in-place edit before it', () => {
  const cmd = ["cd C:/x && cat > $TEMP/body.md <<'EOF'", '## Problema', 'node not a command; gh pr merge', 'EOF', 'node scripts/ship.mjs -m a -b $TEMP/body.md'].join('\n');
  assert.equal(intentOf(row(0, 'bash', cmd)), 'bash node scripts/ship.mjs');
  assert.equal(intentOf(row(0, 'bash', "cd C:/x && sed -i 's/a/b/' f.ts && npx tsc --noEmit")), 'bash npx tsc');
  assert.equal(intentOf(row(0, 'bash', 'cat > f.ts')), 'bash cat >');
});

test('a failure and the retry of the same intent are waste; an unrelated call is not', () => {
  const s = summarize([
    row(0, 'bash', 'node scripts/ship.mjs -m a', 'error', 800, { detail: 'default_branch' }),
    row(2, 'bash', 'node scripts/ship.mjs -m b --branch x', 'ok', 5000),
    row(3, 'read', 'a.ts'),
  ]);
  assert.equal(s.calls, 3); assert.equal(s.bad, 1); assert.equal(s.retryCalls, 1);
  assert.equal(s.wasteSeconds, 5.8);
  assert.deepEqual(s.topFailures[0], { key: 'error: bash node scripts/ship.mjs', calls: 1, seconds: 0.8, sample: 'default_branch' });
});

test('a retry after the window, background rows and rows before since are ignored', () => {
  const s = summarize([
    row(0, 'bash', 'gh pr list', 'timeout', 9000),
    row(30, 'bash', 'gh pr list', 'ok', 700),
    { ...row(31, 'bash', 'gh pr list', 'error'), source: 'background' },
    row(-60, 'bash', 'gh pr list', 'error'),
  ], Date.UTC(2026, 10, 7, 3, 0));
  assert.equal(s.calls, 2); assert.equal(s.retryCalls, 0); assert.equal(s.wasteSeconds, 9);
});

test('tools rank by failures with their failure rate', () => {
  const s = summarize([row(0, 'zoom', '1', 'error'), row(1, 'zoom', '2', 'ok'), row(2, 'bash', 'ls', 'ok')]);
  assert.deepEqual(s.tools, [{ name: 'zoom', calls: 2, bad: 1, badPct: 50, seconds: 0.2 }]);
});
