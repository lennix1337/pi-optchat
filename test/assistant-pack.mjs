import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// npm is a .cmd shim on Windows; use its native shell explicitly, with fixed arguments.
const output = process.platform === 'win32'
  ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm pack --dry-run --json'], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  : execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
const result = JSON.parse(output);
// npm versions emit either an array or a package-name-keyed manifest.
const manifest = Array.isArray(result) ? result[0] : result['pi-optchat'];
assert.equal(manifest?.name, 'pi-optchat');
assert.ok(Array.isArray(manifest.files), 'Missing package file manifest');
const paths = new Set(manifest.files.map(file => file.path));
for (const path of ['src/index.ts', 'src/assistant-client.ts', 'assistant/src/main.ts', 'assistant/src/store/db.ts', 'assistant/src/store/privacy.ts', 'assistant/package.json', 'assistant/README.md', 'skills/personal-assistant/SKILL.md', 'assistant/web/index.html', 'assistant/web/src/app.js', 'assistant/web/src/state.js', 'assistant/web/src/app.css']) {
  assert.ok(paths.has(path), `Missing packaged entry: ${path}`);
}
const forbidden = [...paths].filter(path => /(?:^|\/)(?:node_modules|worktrees|scratchpad|\.optchat|\.pi)(?:\/|$)|\.(?:sqlite|db)(?:-(?:wal|shm|journal))?$|(?:^|\/)(?:assistant|auth|autonomy)\.json$/.test(path));
assert.deepEqual(forbidden, [], 'Runtime or secret configuration must not be packaged');
console.log(JSON.stringify({ dryRun: true, entries: paths.size, required: 12, privateArtifacts: forbidden.length }));
