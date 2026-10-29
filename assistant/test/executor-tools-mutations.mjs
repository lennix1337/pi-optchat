import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Disposable copy inside this checkout (so node_modules resolve upward); each guard removed must fail an assertion.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const home = mkdtempSync(join(repo, 'executor-tools-mutants-'));
const tests = ['executor-tools-service.test.ts', 'tool-review-lifecycle.test.ts', 'executor-tools-default-off.test.ts', 'pi-draft.test.ts'];
const mutations = [
  ['expired-review-ends-task', 'src/runtime/tool-effects.ts', 'if (item.request.expiresAt <= Date.now() || !this.port.ready(', 'if (!this.port.ready('],
  ['decided-review-ends-task', 'src/runtime/tool-effects.ts', ' && this.port.open && !this.port.open(item.request, item.reviewId)', ' && false'],
  ['desk-decides-only-listed-reviews', 'src/ops/executor-desk.ts', "if (!this.reviews().some(review => review.reviewId === reviewId)) throw new Error('review_not_pending');", ''],
  ['executor-script-needs-terminal', 'scripts/executor.mjs', "if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('interactive_terminal_required');", ''],
  ['tools-default-off', 'src/main.ts', 'if (config.executor.tools) {', 'if (true) {'],
  ['model-preview-needs-opt-in', 'src/runtime/pi-draft.ts', "return config.tools && (reply as", "return (reply as"],
  ['review-gateway-requires-review', 'src/runtime/tool-service.ts', "? 'review' : 'deny'", "? 'allow' : 'deny'"],
];
try {
  cpSync(join(repo, 'assistant/src'), join(home, 'assistant/src'), { recursive: true });
  cpSync(join(repo, 'assistant/scripts'), join(home, 'assistant/scripts'), { recursive: true });
  cpSync(join(repo, 'assistant/web'), join(home, 'assistant/web'), { recursive: true });
  mkdirSync(join(home, 'assistant/test'), { recursive: true });
  cpSync(join(repo, 'assistant/test'), join(home, 'assistant/test'), { recursive: true });
  cpSync(join(repo, 'test'), join(home, 'test'), { recursive: true });
  cpSync(join(repo, 'src'), join(home, 'src'), { recursive: true });
  writeFileSync(join(home, 'package.json'), '{"type":"module"}');
  const run = () => spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--test', '--test-concurrency=1', '--test-timeout=60000', ...tests.map(file => join(home, 'assistant/test', file))],
    { cwd: home, encoding: 'utf8', timeout: 240000, maxBuffer: 4000000, windowsHide: true });
  const baseline = run(); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  console.log('baseline: passed');
  let killed = 0;
  for (const [name, file, before, after] of mutations) {
    const path = join(home, 'assistant', file), original = readFileSync(path, 'utf8');
    assert.equal(original.split(before).length, 2, `${name}: unique mutation anchor`);
    writeFileSync(path, original.replace(before, after));
    let result;
    try { result = run(); } finally { writeFileSync(path, original); }
    assert.equal(result.status, 1, `${name}: survived or crashed\n${result.stdout.slice(-3000)}${result.stderr.slice(-2000)}`);
    assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED|test timed out/, `${name}: must fail a regression assertion, not loading or a timeout`);
    assert.match(result.stdout, /^✖ (?!.*\.test\.ts \()/m, `${name}: a named regression test must fail`);
    console.log(`killed: ${name}`); killed++;
  }
  console.log(`${killed}/${mutations.length} executor tool mutations killed`);
} finally { rmSync(home, { recursive: true, force: true }); }
