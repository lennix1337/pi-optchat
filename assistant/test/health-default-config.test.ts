import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantPath } from './assistant-paths.ts';

const health = (home: string, args: string[] = []) =>
  spawnSync(process.execPath, [assistantPath('scripts/health.mjs'), ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: home, USERPROFILE: home } });
const profile = (home: string, name: string) => {
  const dir = join(home, '.optchat-assistant', name); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'server.json'), JSON.stringify({ version: 1, profileId: name, databasePath: join(dir, 'tasks.sqlite'), endpoint: 'http://127.0.0.1:1', token: 'T' }), { mode: 0o600 });
  chmodSync(dir, 0o700);
};

test('health without --config reads the only profile under ~/.optchat-assistant', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-default-'));
  try {
    profile(home, 'only');
    const run = health(home);
    assert.ok(!/Usage:/.test(run.stderr), run.stderr);
    assert.match(run.stdout, /"state":"(stopped|stale_record)"/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('health without --config refuses to guess between several profiles', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-default-'));
  try {
    profile(home, 'a'); profile(home, 'b');
    const run = health(home);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /"code":"config_ambiguous"/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
