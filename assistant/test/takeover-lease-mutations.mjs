import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'takeover-mutants-'));
try {
  cpSync('assistant/src', join(root, 'assistant/src'), { recursive: true });
  cpSync('assistant/test/takeover-lease.test.ts', join(root, 'assistant/test/takeover-lease.test.ts'));
  const path = join(root, 'assistant/src/computer/manager.ts');
  const original = readFileSync(path, 'utf8');
  const anchor = "if (active) fail('computer_operations_active');";
  if (original.split(anchor).length !== 2) throw new Error('mutation anchor mismatch');
  writeFileSync(path, original.replace(anchor, 'if (false) fail(\'computer_operations_active\');'));
  const result = spawnSync(process.execPath, ['--test', join(root, 'assistant/test/takeover-lease.test.ts')], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 1 || !result.stdout.includes('Missing expected rejection')) throw new Error(`mutant did not fail its assertion: ${result.status}\n${result.stdout}\n${result.stderr}`);
  console.log('takeover active-operation guard mutant killed by regression assertion');
} finally { rmSync(root, { recursive: true, force: true }); }
