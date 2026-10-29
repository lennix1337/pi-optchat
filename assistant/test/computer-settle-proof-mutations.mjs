import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Each mutant weakens the settle proof that lets a retry take over a stale removal reservation; the regression
// tests must fail by assertion, not by crashing.
const mutants = [
  { name: 'present container still being removed counts as settled', tests: ['computer-settle-proof.test.ts'],
    old: "return !inspected.uncertain && id === target && !!status && status !== 'removing';", replacement: 'return !inspected.uncertain && id === target && !!status;' },
  { name: 'unreadable census counts as absence', tests: ['computer-settle-proof.test.ts'],
    old: '\n      return ids.code === 0 && !ids.uncertain && !ids.stdout.split(/\\r?\\n/).includes(target);', replacement: '\n      return true;' },
  { name: 'a reservation with no recorded ID is settled even if its holder never failed', tests: ['computer-settle-proof.test.ts', 'takeover-removal-race.test.ts'],
    old: "if (!target) return reservation.phase === 'failed';", replacement: 'if (!target) return true;' },
];
const root = mkdtempSync(join(tmpdir(), 'settle-proof-mutants-'));
try {
  cpSync('assistant/src', join(root, 'assistant/src'), { recursive: true });
  const path = join(root, 'assistant/src/computer/manager.ts');
  const original = readFileSync(path, 'utf8');
  for (const mutant of mutants) {
    if (original.split(mutant.old).length !== 2) throw new Error(`anchor mismatch: ${mutant.name}`);
    writeFileSync(path, original.replace(mutant.old, mutant.replacement));
    for (const test of mutant.tests) cpSync(`assistant/test/${test}`, join(root, `assistant/test/${test}`));
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=30000', ...mutant.tests.map(test => join(root, `assistant/test/${test}`))], { encoding: 'utf8', timeout: 60000 });
    writeFileSync(path, original);
    if (result.status !== 1 || !/AssertionError|Missing expected rejection/.test(result.stdout)) throw new Error(`mutant not killed by assertion: ${mutant.name} ${result.status}\n${result.stdout}\n${result.stderr}`);
    console.log(`killed: ${mutant.name}`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
