import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const mutants = [
  ['mandatory-review', 'assistant/src/policy/gateway.ts', 'admission.review || reviewId !== undefined', 'admission.review', 'assistant/test/tool-review.test.ts', 'Missing expected rejection'],
  ['one-way', 'assistant/src/runtime/tool-effects.ts', "SET state = 'uncertain' WHERE id = ? AND state = 'dispatching'", "SET state = 'waiting' WHERE id = ? AND state = 'dispatching'", 'assistant/test/tool-effects.test.ts', 'waiting'],
  ['restore', 'assistant/src/ops/backup.ts', "{ key: 'toolEffects', table: 'tool_effects', sql: \"UPDATE tool_effects SET state = 'uncertain' WHERE state IN ('preparing', 'waiting', 'dispatching')\" },", '', 'assistant/test/backup-restore.test.ts', 'toolEffects'],
  ['stale-readiness', 'assistant/src/runtime/task-executor.ts', "? this.options.store.transitionWithLease(task.taskId, task.revision, next, event, this.runtime.leaseIdentity())", '? this.options.store.transition(task.taskId, task.revision, next, event)', 'assistant/test/tool-readiness.test.ts', 'queued'],
  ['pending-binding', 'assistant/src/policy/gateway.ts', 'return row ? { metadata: Object.freeze({ ...item.metadata }), payload: Buffer.from(item.payload) } : undefined;', 'return { metadata: Object.freeze({ ...item.metadata }), payload: Buffer.from(item.payload) };', 'assistant/test/tool-review.test.ts', 'Expected values to be strictly equal'],
  ['pending-readonly', 'assistant/src/policy/gateway.ts', 'return row ? { metadata: Object.freeze({ ...item.metadata }), payload: Buffer.from(item.payload) } : undefined;', "this.db.prepare(\"UPDATE reviews SET state = 'revoked' WHERE id = ?\").run(reviewId); return row ? { metadata: Object.freeze({ ...item.metadata }), payload: Buffer.from(item.payload) } : undefined;", 'assistant/test/tool-review.test.ts', 'pending review remains readable'], 
];
for (const [name, file, oldText, newText, testFile, marker] of mutants) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-review-mutant-'));
  try {
    cpSync(resolve('assistant/src'), join(dir, 'assistant/src'), { recursive: true });
    cpSync(resolve('assistant/test'), join(dir, 'assistant/test'), { recursive: true });
    const path = join(dir, file), source = readFileSync(path, 'utf8');
    if (!source.includes(oldText) || source.indexOf(oldText) !== source.lastIndexOf(oldText)) throw new Error(`mutation_anchor:${name}`);
    writeFileSync(path, source.replace(oldText, newText));
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=30000', join(dir, testFile)], { encoding: 'utf8', timeout: 40000 });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 1 || !output.includes(marker) || !output.includes('AssertionError') || output.includes('test timed out')) throw new Error(`mutation_not_killed:${name}:${result.status}:${output.slice(-1500)}`);
    console.log(`killed ${name}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
