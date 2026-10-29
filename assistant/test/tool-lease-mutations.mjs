import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const mutants = [
  ['assistant/src/runtime/tool-effects.ts', "if (!lease.token || owner?.owner !== lease.owner || owner.token !== lease.token) throw new Error('lease_lost');"],
  ['assistant/src/store/db.ts', "if (!lease.token || row?.owner !== lease.owner || row.token !== lease.token) throw new Error('lease_lost');"],
  ['assistant/src/runtime/tool-task.ts', "if (!store.matchesProfile(profileId) || !store.matchesDatabase(effects.databasePath)) throw new Error('tool_database_mismatch');"],
];
for (const [file, guard] of mutants) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-lease-mutant-'));
  try {
    cpSync(resolve('assistant/src'), join(dir, 'assistant/src'), { recursive: true });
    cpSync(resolve('assistant/test/tool-lease.test.ts'), join(dir, 'assistant/test/tool-lease.test.ts'));
    cpSync(resolve('assistant/test/task-fixtures.ts'), join(dir, 'assistant/test/task-fixtures.ts'));
    const path = join(dir, file); const source = readFileSync(path, 'utf8');
    if (!source.includes(guard) || source.indexOf(guard) !== source.lastIndexOf(guard)) throw new Error('mutation_anchor');
    writeFileSync(path, source.replace(guard, ''));
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=10000', join(dir, 'assistant/test/tool-lease.test.ts')], { encoding: 'utf8', timeout: 15000 });
    const output = `${result.stdout}\n${result.stderr}`;
    const marker = file.includes('tool-effects') ? '1 !== 0' : file.includes('tool-task') ? 'Missing expected exception' : 'Missing expected rejection';
    if (result.status !== 1 || !output.includes(marker) || !output.includes('lease steal fences admission') || output.includes('test timed out')) throw new Error(`mutation_not_killed:${file}:${result.status}:${output.slice(-1000)}`);
    console.log(`killed ${file}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
