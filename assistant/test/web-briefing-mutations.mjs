import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'briefing-boundary-'));
const variants = [
  ['profile', 'briefing/view.ts', 'value.profileId !== profileId', 'false', /200 !== 500/],
  ['revocation', 'channels/stored-panel.ts', 'if (!stillCurrent())', 'if (false)', /200 !== 401/],
  ['no-refresh', 'channels/stored-panel.ts', 'await this.briefings.latest()', 'await this.briefings.refresh()', /1 !== 0/],
];
try {
  for (const [name, file, before, after, reason] of variants) {
    const dir = join(root, name); mkdirSync(join(dir, 'test'), { recursive: true });
    for (const folder of ['src', 'web']) cpSync(join(source, folder), join(dir, folder), { recursive: true });
    cpSync(join(source, 'package.json'), join(dir, 'package.json'));
    cpSync(join(source, 'test/web-briefing.test.ts'), join(dir, 'test/web-briefing.test.ts'));
    const path = join(dir, 'src', file), text = readFileSync(path, 'utf8');
    assert.equal(text.split(before).length, 2, name + ' anchor'); writeFileSync(path, text.replace(before, after));
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', join(dir, 'test/web-briefing.test.ts')], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 1, `${name}: ${result.error ?? result.stderr}`);
    assert.match(result.stdout, /AssertionError/, name); assert.match(result.stdout, reason, name);
    console.log(`killed ${name} by expected assertion`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
