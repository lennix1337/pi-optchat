import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Each restore-hold guard is removed in a disposable source copy; the restore regression must fail by assertion.
const mutants = [
  ['executor ignores restore holds', 'assistant/src/runtime/task-executor.ts', 'if (this.options.store.restoreHeld(task.taskId, task.revision)) return null;', 'void 0;'],
  ['restore records no holds', 'assistant/src/ops/backup.ts', 'fenced.tasks += Number(db.prepare(RESTORE_HOLDS_FENCE).run().changes);', 'void RESTORE_HOLDS_FENCE;'],
  ['hold survives a later revision', 'assistant/src/store/db.ts', "return !!this.taskRow('SELECT 1 FROM restore_holds WHERE profile = ? AND task_id = ? AND revision = ?', taskId, revision);", "return !!this.taskRow('SELECT 1 FROM restore_holds WHERE profile = ? AND task_id = ? AND ? > 0', taskId, revision);"],
];
for (const [name, file, guard, replacement] of mutants) {
  const dir = mkdtempSync(join(tmpdir(), 'executor-restore-mutant-'));
  try {
    cpSync(resolve('assistant/src'), join(dir, 'assistant/src'), { recursive: true });
    cpSync(resolve('assistant/test'), join(dir, 'assistant/test'), { recursive: true });
    const path = join(dir, file);
    const source = readFileSync(path, 'utf8');
    if (source.split(guard).length !== 2) throw new Error(`mutation_anchor:${name}`);
    writeFileSync(path, source.replace(guard, replacement));
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=60000', join(dir, 'assistant/test/executor-restore.test.ts')], { encoding: 'utf8', timeout: 120000 });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 1 || !output.includes('AssertionError') || output.includes('test timed out')) throw new Error(`mutation_not_killed:${name}:${result.status}:${output.slice(-1500)}`);
    console.log(`killed ${name}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
