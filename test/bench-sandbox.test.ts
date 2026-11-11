import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSandbox, blockNetwork, copyProfile } from '../scripts/bench-sandbox.ts';

const withDirs = (run: (dir: string) => void | Promise<void>) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-sandbox-'));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const profile = (home: string, files: Record<string, string>) => {
  const dir = join(home, 'profiles', 'p'); mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), text); }
  return dir;
};

test('a bench home that holds an assistant.json is refused, so a bench turn can never become a real task', withDirs(dir => {
  const home = join(dir, 'home'); profile(home, { 'assistant.json': JSON.stringify({ version: 1, profileId: 'p', endpoint: 'http://127.0.0.1:1', token: 'x' }) });
  assert.throws(() => assertSandbox(home, join(dir, 'real')), /assistant\.json configures a live service/);
}));

test('a bench home is refused when it is, contains or sits inside the real data home', withDirs(dir => {
  const real = join(dir, 'real'); mkdirSync(real);
  assert.throws(() => assertSandbox(real, real), /real OptChat home/);
  assert.throws(() => assertSandbox(join(real, 'copy'), real), /real OptChat home/);
  assert.throws(() => assertSandbox(dir, real), /real OptChat home/);
}));

test('any profile JSON that carries an endpoint or credential key is refused, whatever its name', withDirs(dir => {
  const home = join(dir, 'home'); profile(home, { 'other-service.json': JSON.stringify({ endpoint: 'http://127.0.0.1:2' }) });
  assert.throws(() => assertSandbox(home, join(dir, 'real')), /live-service endpoint or credential/);
}));

test('copyProfile takes only the data allowlist, and the copy passes the guard', withDirs(dir => {
  const source = join(dir, 'source'); mkdirSync(source);
  for (const name of ['main', 'runs']) { mkdirSync(join(source, name)); writeFileSync(join(source, name, 'a.jsonl'), '{}\n'); }
  for (const name of ['assistant.json', 'slack-threads.json', 'autonomy.json', 'config.json', 'ai-memory-sync.json']) writeFileSync(join(source, name), '{"endpoint":"http://127.0.0.1:3","token":"t"}');
  const home = join(dir, 'home'), target = copyProfile(source, home, 'p');
  assert.deepEqual(readdirSync(target).sort(), ['main', 'runs']);
  assert.ok(existsSync(join(target, 'main', 'a.jsonl')));
  assertSandbox(home, join(dir, 'real'));
}));

test('blockNetwork makes fetch fail for loopback and remote URLs alike', async () => {
  const real = globalThis.fetch;
  try {
    blockNetwork();
    for (const url of ['http://127.0.0.1:47761/tasks', 'https://example.com/']) await assert.rejects(fetch(url), /network access refused/);
  } finally { globalThis.fetch = real; }
});
