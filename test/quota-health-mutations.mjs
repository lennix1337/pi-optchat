import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'quota-mutants-'));
const mutations = [
  ['expired-window', 'src/quota-health.ts', 'nonnegative(value) && value > now', 'nonnegative(value)'],
  ['unsafe-label', 'src/quota-health.ts', 'if (!safeIdentifier(id)) return [];', 'if (false) return [];'],
  ['invalid-date', 'src/quota-health.ts', ' && value <= 8.64e15', ''],
  ['threshold', 'src/quota-health.ts', 'QUOTA_NEAR_PERCENT = 90', 'QUOTA_NEAR_PERCENT = 95'],
  ['one-spent-is-not-all', 'src/quota-health.ts', 'all.some(a => !a.blockedUntil)', 'all.every(a => !a.blockedUntil)'],
  ['earliest-reset', 'src/quota-health.ts', 'Math.min(...all.map', 'Math.max(...all.map'],
  ['quota-wake', 'src/prod-health.ts', 'probes: [quotaProbe()], file: QUOTA_HEALTH_FILE }), channel: null, wakes: false', 'probes: [quotaProbe()], file: QUOTA_HEALTH_FILE }), channel: null, wakes: true'],
  ['summary', 'src/slack-reports.ts', "if (quota?.length) lines.push('', '*Cotas dos modelos*'", "if (false) lines.push('', '*Cotas dos modelos*'"],
  ['forecast', 'src/quota-health.ts', '(a.used ?? 0) >= QUOTA_NEAR_PERCENT', '(a.used ?? 0) > 1000'],
];

function run() {
  const result = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', './test/support.ts', '--test', 'test/quota-health.test.ts'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  if (result.error || result.signal) throw result.error ?? new Error(`test process signalled ${result.signal}`);
  return { code: result.status, output: result.stdout + result.stderr };
}

try {
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(root, 'assistant/src'), join(dir, 'assistant/src'), { recursive: true });
  cpSync(join(root, 'package.json'), join(dir, 'package.json'));
  mkdirSync(join(dir, 'test'));
  cpSync(join(root, 'test/support.ts'), join(dir, 'test/support.ts'));
  cpSync(join(root, 'test/quota-health.test.ts'), join(dir, 'test/quota-health.test.ts'));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const baseline = run();
  assert.equal(baseline.code, 0, baseline.output);
  for (const [name, file, before, after] of mutations) {
    const path = join(dir, file), original = readFileSync(path, 'utf8');
    assert.equal(original.split(before).length, 2, `${name}: unique anchor required`);
    try {
      writeFileSync(path, original.replace(before, after));
      const result = run();
      assert.notEqual(result.code, 0, `${name}: survived`);
      assert.match(result.output, /AssertionError/, `${name}: not an assertion failure\n${result.output}`);
      assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED/, `${name}: harness crash`);
      console.log(`${name}: caught by assertion`);
    } finally { writeFileSync(path, original); }
  }
  const restored = run();
  assert.equal(restored.code, 0, restored.output);
  console.log(`${mutations.length} mutants caught; clean baseline and restored source passed`);
} finally { rmSync(dir, { recursive: true, force: true }); }
