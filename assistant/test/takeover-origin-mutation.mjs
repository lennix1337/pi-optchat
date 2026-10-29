import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'takeover-origin-mutant-'));
try {
  cpSync('assistant/src', join(root, 'assistant/src'), { recursive: true });
  cpSync('assistant/test/takeover-graphical.test.ts', join(root, 'assistant/test/takeover-graphical.test.ts'));
  const path = join(root, 'assistant/src/computer/graphical-takeover.ts');
  const original = readFileSync(path, 'utf8');
  const anchor = " || request.headers.origin !== origin";
  if (original.split(anchor).length !== 2) throw new Error('mutation anchor mismatch');
  writeFileSync(path, original.replace(anchor, ''));
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=30000', join(root, 'assistant/test/takeover-graphical.test.ts')], { encoding: 'utf8', timeout: 40000 });
  if (result.status !== 1 || !result.stdout.includes('Expected values to be strictly equal')) throw new Error(`mutant not killed by assertion: ${result.status}\n${result.stdout}\n${result.stderr}`);
  console.log('WebSocket origin guard mutant killed');
} finally { rmSync(root, { recursive: true, force: true }); }
