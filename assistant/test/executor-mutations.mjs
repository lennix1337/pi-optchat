import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Disposable copy of the executor sources; each guard removed must fail an assertion of assistant-executor.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'assistant-executor-mutants-'));
// A worktree has no node_modules of its own: link the one Node resolves from the repo, never a stray copy above %TEMP%.
const modules = (dir => { for (; !existsSync(join(dir, 'node_modules')); dir = dirname(dir)) if (dirname(dir) === dir) throw new Error('node_modules not found'); return join(dir, 'node_modules'); })(repo);
const tests = ['task-executor.test.ts', 'task-response-reader.test.ts', 'pi-draft.test.ts', 'account-routes.test.ts'];
const mutations = [
  ['admitted-channel', 'task-executor.ts', '!this.options.channels.includes(origin.channelId)', 'false'],
  ['wait-is-not-failure', 'task-executor.ts', "if (result.kind === 'wait') return WAIT;", ''],
  ['wait-for-usable-account', 'task-executor.ts', 'if (!await ready()) return null;', ''],
  ['bounded-account-switches', 'task-executor.ts', 'if (attempt >= MAX_ROUTE_ATTEMPTS)', 'if (false)'],
  ['account-error-waits', 'pi-draft.ts', "if (last?.role === 'assistant' && last.stopReason === 'error' && accountFailed(last.errorMessage ?? '')) return WAIT;", ''],
  ['route-cooled-after-failure', 'account-routes.ts', 'this.cooled.set(`${route.provider}/${route.model}`, this.now() + ms);', ''],
  ['shared-rotation-cooldown', 'account-routes.ts', 'positiveAt(state.exhaustedUntilByProvider, route.provider) > now ||', ''],
  ['context-error-not-account', 'account-routes.ts', "if (matches('ignore')) return null;", ''],
  ['pinned-route-only', 'account-routes.ts', 'if (this.fixed) return', 'if (false) return'],
  ['saved-default-only', 'account-routes.ts', 'if (model && has({ provider, model })) routes.push', 'if (model) routes.push'],
  ['admitted-source', 'task-executor.ts', "(origin.source.sourceKind === 'trusted-local-human' ||\n      origin.source.sourceKind === 'external' && origin.source.actorId === 'web-operator')", 'true'],
  ['single-attempt', 'task-executor.ts', 'maxAttempts: 1,', 'maxAttempts: 3,'],
  ['clean-stop-not-resent', 'task-executor.ts', "if (job.state === 'queued' && job.attempts > 0) this.runtime.cancel(job.id);", ''],
  ['stale-revision-skipped', 'task-executor.ts', 'return null;\n      throw error;', 'throw error;'],
  ['answer-consumed', 'task-executor.ts', 'this.options.store.getResponse(task.taskId, task.inputRevision)', 'null'],
  ['draft-kind', 'task-executor.ts', "!['input', 'draft'].includes(String(v.kind))", 'false'],
  ['options-only-on-questions', 'task-executor.ts', "keys === 'kind,options,text' && v.kind === 'input' && validOptions(v.options)", "keys === 'kind,options,text'"],
  ['options-bounded', 'task-executor.ts', 'value.length >= 2 && value.length <= 4 && new Set(value).size === value.length', 'true'],
  ['prompt-of-current-revision', 'task-executor.ts', 'this.current({ ...task, revision: task.revision - 1 })', 'this.current({ ...task, revision: 2 })'],
  ['tool-free-session', 'pi-draft.ts', "tools: [], noTools: 'all', ", ''],
  ['output-parsed', 'pi-draft.ts', "return config.tools && (reply as { kind?: unknown } | null)?.kind === 'browser_text' ? parsePreview(reply) : parseDraftResult(reply);", "return { kind: 'draft', text: session.getLastAssistantText() || 'x' };"],
];
try {
  cpSync(join(repo, 'assistant/src'), join(home, 'assistant/src'), { recursive: true });
  mkdirSync(join(home, 'assistant/test'), { recursive: true });
  for (const file of [...tests, 'task-fixtures.ts']) cpSync(join(repo, 'assistant/test', file), join(home, 'assistant/test', file));
  cpSync(join(repo, 'src'), join(home, 'src'), { recursive: true });
  mkdirSync(join(home, 'test'));
  cpSync(join(repo, 'test/fixture-model.ts'), join(home, 'test/fixture-model.ts'));
  writeFileSync(join(home, 'package.json'), '{"type":"module"}');
  symlinkSync(modules, join(home, 'node_modules'), 'junction');
  const run = () => spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--test', '--test-timeout=30000', ...tests.map(file => join(home, 'assistant/test', file))],
    { cwd: home, encoding: 'utf8', timeout: 120000, maxBuffer: 4000000, windowsHide: true });
  const baseline = run(); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  console.log('baseline: passed');
  let killed = 0;
  for (const [name, file, before, after] of mutations) {
    const path = join(home, 'assistant/src/runtime', file), original = readFileSync(path, 'utf8');
    assert.equal(original.split(before).length, 2, `${name}: unique mutation anchor`);
    writeFileSync(path, original.replace(before, after));
    let result;
    try { result = run(); } finally { writeFileSync(path, original); }
    assert.equal(result.status, 1, `${name}: survived or crashed\n${result.stdout.slice(-3000)}${result.stderr.slice(-2000)}`);
    assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED/, `${name}: must fail a regression test, not module loading`);
    assert.match(result.stdout, /^✖ (?!.*\.test\.ts \()/m, `${name}: a named test must fail`);
    console.log(`killed: ${name}`); killed++;
  }
  console.log(`${killed}/${mutations.length} executor mutations killed`);
} finally { rmSync(home, { recursive: true, force: true }); }
