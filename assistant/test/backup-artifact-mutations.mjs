import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'assistant-backup-mutants-'));
const mutations = [
  ['portable-file-directory-collision', 'backup.ts', "names.has(parents.join('/'))", 'false'],
  ['portable-case-collision', 'backup.ts', 'names.has(entry.name.toLowerCase())', 'false'],
  ['logical-wal-budget', 'backup.ts', 'logicalBytes > budget', 'false'],
  ['portable-database-name', 'backup.ts', 'name.length > 0', 'true'],
  ['registry-profile', 'artifact-backup.ts', "if (row.profile !== profileId || artifact.profileId !== profileId)", 'if (false)'],
  ['registry-links', 'artifact-backup.ts', 'info.nlink !== 1 || info.size > MAX_BACKUP_BYTES', 'false || info.size > MAX_BACKUP_BYTES'],
  ['content-hash', 'artifact-backup.ts', 'image.length !== ref.size || sha256(image) !== ref.hash', 'false'],
  ['restore-hash', 'artifact-backup.ts', 'sha256(bytes) !== ref.hash', 'false'],
  ['restore-target', 'backup.ts', '  checkDirectoryPrivacy(into);', ''],
  ['archive-digest', 'backup.ts', 'sha256(image) !== entry.sha256', 'false'],
  ['archive-name', 'backup.ts', '!validName ||', ''],
];
try {
  cpSync(join(source, 'src'), join(home, 'src'), { recursive: true });
  cpSync(join(source, 'test'), join(home, 'test'), { recursive: true });
  writeFileSync(join(home, 'package.json'), '{"type":"module"}');
  const run = () => spawnSync(process.execPath, ['--test', join(home, 'test/backup-artifacts.test.ts')], { encoding: 'utf8', timeout: 60000, maxBuffer: 1000000, windowsHide: true });
  const baseline = run(); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  console.log('baseline: passed');
  for (const [name, file, before, after] of mutations) {
    const path = join(home, 'src/ops', file), original = readFileSync(path, 'utf8');
    assert.equal(original.split(before).length, 2, `${name}: unique mutation anchor`);
    writeFileSync(path, original.replace(before, after));
    let result;
    try { result = run(); } finally { writeFileSync(path, original); }
    assert.equal(result.status, 1, `${name}: survived or crashed\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION/, `${name}: must fail a regression assertion, not module loading`);
    console.log(`killed: ${name}`);
  }
  console.log(`${mutations.length}/${mutations.length} backup security mutations killed`);
} finally { rmSync(home, { recursive: true, force: true }); }
