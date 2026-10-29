import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const mutants = [
  { file: 'manager.ts', test: 'takeover-reservation-fencing.test.ts', old: "DELETE FROM computers WHERE id = ? AND owner = ? AND state = ? AND EXISTS (SELECT 1 FROM computer_lifecycle WHERE id = ? AND token = ?)", replacement: "DELETE FROM computers WHERE id = ? AND owner = ? AND state = ? AND (? IS NOT NULL OR ? IS NULL)" },
  { file: 'removal.ts', test: 'takeover-removal-identity.test.ts', old: 'const target = expectedId ?? name;', replacement: 'const target = name;' },
];
const root = mkdtempSync(join(tmpdir(), 'takeover-identity-mutants-'));
try {
  cpSync('assistant/src', join(root, 'assistant/src'), { recursive: true });
  for (const mutant of mutants) {
    cpSync(`assistant/test/${mutant.test}`, join(root, `assistant/test/${mutant.test}`));
    const path = join(root, 'assistant/src/computer', mutant.file), original = readFileSync(path, 'utf8');
    if (original.split(mutant.old).length !== 2) throw new Error(`anchor mismatch: ${mutant.test}`);
    let changed = original.replace(mutant.old, mutant.replacement);
    if (mutant.test === 'takeover-reservation-fencing.test.ts') {
      const anchor = "DELETE FROM computer_lifecycle WHERE id = ? AND token = ?";
      if (changed.split(anchor).length !== 2) throw new Error('release anchor mismatch');
      changed = changed.replace(anchor, 'DELETE FROM computer_lifecycle WHERE id = ? AND (? IS NOT NULL OR ? IS NULL)').replace(".run(id, token);\n    if (Number(result.changes) !== 1) fail('computer_transition');\n  }", ".run(id, token, token);\n    if (Number(result.changes) !== 1) fail('computer_transition');\n  }");
    }
    writeFileSync(path, changed);
    const result = spawnSync(process.execPath, ['--test', join(root, `assistant/test/${mutant.test}`)], { encoding: 'utf8', timeout: 30000 });
    writeFileSync(path, original);
    if (result.status !== 1 || !result.stdout.includes('AssertionError')) throw new Error(`mutant not killed by assertion: ${mutant.test}\n${result.stdout}\n${result.stderr}`);
    console.log(`${mutant.test}: mutant killed`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
