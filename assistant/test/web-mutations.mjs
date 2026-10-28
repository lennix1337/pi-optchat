import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'assistant-web-mutants-'));
const variants = [
  ['host', 'if (!host) {', 'if (false) {', /200 !== 403/],
  ['origin', "req.headers.origin === `http://${host}`", 'true', /200 !== 403/],
  ['csrf', "req.method === 'POST' && req.headers['x-assistant-csrf'] !== session.csrf", 'false', /200 !== 403/],
  ['web-is-not-terminal', "sourceKind: 'external'", "sourceKind: 'trusted-local-human'", /trusted-local-human/],
  ['rotate', 'if (oldId) this.sessions.delete(oldId);', '', /200 !== 401/],
  ['idle', ' || now - session.seen > idleMs', '', /200 !== 401/],
  ['absolute-age', ' || now - session.created > absoluteMs', '', /200 !== 401/],
  ['bounded-sessions', 'this.sessions.size >= 32', 'false', /200 !== 429/],
  ['login-throttle', 'this.failures.length >= loginFailures', 'false', /200 !== 429/],
];
try {
  for (const [name, before, after, expected] of variants) {
    const dir = join(root, name); mkdirSync(join(dir, 'test'), { recursive: true });
    for (const folder of ['src', 'web']) cpSync(join(sourceRoot, folder), join(dir, folder), { recursive: true });
    cpSync(join(sourceRoot, 'package.json'), join(dir, 'package.json'));
    for (const file of ['web.test.ts', 'web-session.test.ts']) cpSync(join(sourceRoot, 'test', file), join(dir, 'test', file));
    const file = join(dir, 'src', 'channels', 'web.ts');
    const source = readFileSync(file, 'utf8'); assert.equal(source.split(before).length, 2, `nonunique mutant ${name}`);
    writeFileSync(file, source.replace(before, after));
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', join(dir, 'test', 'web.test.ts'), join(dir, 'test', 'web-session.test.ts')], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, `${name}: ${result.error ?? result.stderr}`);
    assert.match(result.stdout, /AssertionError/, name); assert.match(result.stdout, expected, name);
    console.log(`killed ${name}`);
  }
  console.log(JSON.stringify({ mutants: variants.length, killed: variants.length, survivors: 0 }));
} finally { rmSync(root, { recursive: true, force: true }); }
