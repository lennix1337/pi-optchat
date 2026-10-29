import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'display-cli-mutants-'));
const file = join(root, 'display-learning.mjs');
let source = readFileSync('assistant/scripts/display-learning.mjs', 'utf8');
source = source.replaceAll("'../src/", `'${pathToFileURL(resolve('assistant/src')).href}/`);
const mutants = [
  ['stdin-only', "if (arg !== undefined || version !== undefined) throw new Error('candidate_must_use_stdin');", 'void arg;'],
  ['stdin-bound', "if (size > 1024) throw new Error('candidate_too_large');", 'void size;'],
  ['terminal-authority', "if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('interactive_terminal_required');", 'void 0;'],
];
try {
  for (const [name, old, replacement] of mutants) {
    if (!source.includes(old)) throw new Error(`missing mutation anchor: ${name}`);
    writeFileSync(file, source.replace(old, replacement));
    const result = spawnSync(process.execPath, ['--test', 'assistant/test/display-learning-cli.test.ts'], { encoding: 'utf8', timeout: 120000, env: { ...process.env, DISPLAY_LEARNING_TEST_CLI: file } });
    if (result.error || result.status === 0 || !/AssertionError|ERR_ASSERTION/.test(result.stdout + result.stderr)) throw new Error(`mutation not killed by assertion: ${name}: ${result.stdout} ${result.stderr}`);
    console.log(`${name}: killed`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
