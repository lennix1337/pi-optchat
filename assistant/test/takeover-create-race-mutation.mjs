import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'takeover-create-mutant-'));
try {
  cpSync('assistant/src', join(root, 'assistant/src'), { recursive: true });
  cpSync('assistant/test/takeover-create-race.test.ts', join(root, 'assistant/test/takeover-create-race.test.ts'));
  const path = join(root, 'assistant/src/computer/manager.ts');
  const original = readFileSync(path, 'utf8');
  const anchor = "if (existing && existing.state !== 'ready') fail('computer_transition');";
  if (original.split(anchor).length !== 2) throw new Error('mutation anchor mismatch');
  writeFileSync(path, original.replace(anchor, "if (false) fail('computer_transition');"));
  const result = spawnSync(process.execPath, ['--test', join(root, 'assistant/test/takeover-create-race.test.ts')], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 1 || !result.stdout.includes('Missing expected rejection')) throw new Error(`mutant not killed: ${result.status}\n${result.stdout}\n${result.stderr}`);
  console.log('create reservation guard mutant killed');
} finally { rmSync(root, { recursive: true, force: true }); }
