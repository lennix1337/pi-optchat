import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const mutants = [
  { file: 'manager.ts', test: 'takeover-owner-cleanup.test.ts', old: "if (this.db.prepare('SELECT token FROM computer_owner_cleanup WHERE owner = ?').get(this.options.owner)) fail('computer_cleanup_active');\n      const existing", replacement: "if (false) fail('computer_cleanup_active');\n      const existing" },
  { file: 'manager.ts', test: 'takeover-uncertain-start.test.ts', old: "if (run.uncertain || (run.code === 0 && !/^[a-f0-9]{64}$/.test(run.stdout.trim())))", replacement: "if (run.code === 0 && !/^[a-f0-9]{64}$/.test(run.stdout.trim()))" },
  { file: 'graphical-takeover.ts', test: 'takeover-graphical.test.ts', old: 'catch (error) { teardown = undefined; throw error; }', replacement: 'catch (error) { throw error; }' },
];
const root = mkdtempSync(join(tmpdir(), 'takeover-review-mutants-'));
try {
  cpSync('assistant/src', join(root, 'assistant/src'), { recursive: true });
  for (const mutant of mutants) {
    cpSync(`assistant/test/${mutant.test}`, join(root, `assistant/test/${mutant.test}`));
    const path = join(root, 'assistant/src/computer', mutant.file);
    const original = readFileSync(path, 'utf8');
    if (original.split(mutant.old).length !== 2) throw new Error(`anchor mismatch: ${mutant.test}`);
    writeFileSync(path, original.replace(mutant.old, mutant.replacement));
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=30000', join(root, `assistant/test/${mutant.test}`)], { encoding: 'utf8', timeout: 40000 });
    writeFileSync(path, original);
    if (result.status !== 1 || !result.stdout.includes('AssertionError')) throw new Error(`mutant not killed: ${mutant.test} ${result.status}\n${result.stdout}\n${result.stderr}`);
    console.log(`${mutant.test}: mutant killed`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
