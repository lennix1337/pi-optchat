import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'tool-handoff-mutant-'));
try {
  cpSync(resolve('assistant/src'), join(dir, 'assistant/src'), { recursive: true });
  cpSync(resolve('assistant/test'), join(dir, 'assistant/test'), { recursive: true });
  const path = join(dir, 'assistant/src/ops/backup.ts');
  const source = readFileSync(path, 'utf8');
  const guard = `  { key: 'jobs', table: 'jobs', sql: "UPDATE jobs SET state = 'blocked', error = 'restored_unreconciled' WHERE kind = 'draft' AND state = 'done' AND CASE WHEN json_valid(result) THEN json_extract(result, '$.kind') = 'browser_text' ELSE 0 END" },`;
  if (!source.includes(guard) || source.indexOf(guard) !== source.lastIndexOf(guard)) throw new Error('mutation_anchor');
  writeFileSync(path, source.replace(guard, ''));
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=120000', join(dir, 'assistant/test/tool-backup-handoff.test.ts')], { encoding: 'utf8', timeout: 140000 });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 1 || !output.includes('AssertionError') || !output.includes('restored preview job must not recreate effect') || !output.includes("'done' !== 'blocked'") || output.includes('test timed out')) throw new Error(`mutation_not_killed:${result.status}:${output.slice(-2000)}`);
  console.log('killed completed preview restore fence');
} finally { rmSync(dir, { recursive: true, force: true }); }
