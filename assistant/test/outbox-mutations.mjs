// Disposable-source negative controls for the outbox: removing each durable guard must fail an outbox test.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'assistant-outbox-mutants-'));
const tests = ['service-outbox.test.ts'];
const variants = [
  // Staging outside the state change's transaction would let a rolled-back change leave an effect behind.
  ['stage-without-transaction', 'outbox/outbox.ts', 'if (!this.db.isTransaction) throw new Error(\'outbox_requires_transaction\');', ''],
  // A conflicting replay of an idempotency key must be refused, not silently accepted.
  ['conflict-silent', 'outbox/outbox.ts', "throw new Error('outbox_conflict');\n      return 'duplicate';", "return 'duplicate';"],
  // A restart must not turn a row interrupted mid-call back into pending (that is the duplicate-send path).
  ['recover-to-pending', 'outbox/outbox.ts', "SET state = 'uncertain', reason = 'interrupted', updated = ? WHERE profile = ? AND state = 'sending'", "SET state = 'pending', reason = 'interrupted', updated = ? WHERE profile = ? AND state = 'sending'"],
  // A transport error that is not a definite refusal is uncertain; resending it could repeat the effect.
  ['uncertain-retried', 'outbox/outbox.ts', "return { kind: 'uncertain', reason: 'transport_error' };", "return { kind: 'retry', code: 'transport_error' };"],
  // A definite refusal is terminal; only retryable ones return to pending.
  ['definite-refusal-retried', 'outbox/outbox.ts', "if (error.retryable && byDispatcher) return { kind: 'retry', code: error.message };\n    return { kind: 'failed', code: error.message };", "return { kind: 'retry', code: error.message };"],
  // The claim is what keeps two dispatchers from sending the same row.
  ['claim-ignored', 'outbox/outbox.ts', 'if (!this.claim(row.id)) continue;', ''],
];
let killed = 0;
try {
  for (const [name, path, before, after] of variants) {
    const dir = join(root, name); mkdirSync(join(dir, 'test'), { recursive: true });
    cpSync(join(sourceRoot, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(sourceRoot, 'package.json'), join(dir, 'package.json'));
    for (const file of tests) cpSync(join(sourceRoot, 'test', file), join(dir, 'test', file));
    const file = join(dir, 'src', path);
    const source = readFileSync(file, 'utf8');
    assert.equal(source.split(before).length, 2, `nonunique mutant ${name}`);
    writeFileSync(file, source.replace(before, after));
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--test', ...tests.map(t => join(dir, 'test', t))], { env, encoding: 'utf8', timeout: 90000 });
    assert.equal(result.status, 1, `${name} survived`);
    assert.match(result.stdout, /not ok|failed/, `${name}: failed for an unexpected reason`);
    killed++; console.log(`killed ${name}`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ mutants: variants.length, killed, survivors: variants.length - killed }));
