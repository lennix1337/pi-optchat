import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { aiMemoryDataDir, aiMemoryToken } from '../src/ai-memory.ts';

// Restore the environment even when an assertion fails; never read the operator's token.
test('ai-memory authentication uses native paths and honors explicit overrides', () => {
  const keys = ['AI_MEMORY_DATA_DIR', 'AI_MEMORY_AUTH_TOKEN', 'LOCALAPPDATA'] as const;
  const saved = keys.map(key => process.env[key]);
  mkdirSync('scratchpad', { recursive: true });
  const dir = mkdtempSync(join('scratchpad', 'ai-memory-auth-'));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(aiMemoryDataDir('darwin'), join(homedir(), 'Library', 'Application Support', 'ai-memory'));
    assert.equal(aiMemoryDataDir('linux'), join(homedir(), '.local', 'share', 'ai-memory'));
    assert.equal(aiMemoryDataDir('win32'), join(homedir(), 'AppData', 'Local', 'ai-memory'));
    process.env.LOCALAPPDATA = join(dir, 'local-app-data');
    assert.equal(aiMemoryDataDir('win32'), join(process.env.LOCALAPPDATA, 'ai-memory'));

    process.env.AI_MEMORY_DATA_DIR = dir;
    for (const platform of ['darwin', 'linux', 'win32'] as const) assert.equal(aiMemoryDataDir(platform), dir);
    assert.equal(aiMemoryToken(), undefined);
    writeFileSync(join(dir, 'auth-token'), '  synthetic-file-token\n');
    assert.equal(aiMemoryToken(), 'synthetic-file-token');
    process.env.AI_MEMORY_AUTH_TOKEN = ' synthetic-env-token ';
    assert.equal(aiMemoryToken(), 'synthetic-env-token');
    process.env.AI_MEMORY_AUTH_TOKEN = '  ';
    assert.equal(aiMemoryToken(), 'synthetic-file-token');
    writeFileSync(join(dir, 'auth-token'), '\n');
    assert.equal(aiMemoryToken(), undefined);
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
